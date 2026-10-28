import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { OpEnvelope } from '@syncanvas/shared';
import type { RoomMember } from './rooms.js';

/**
 * The cross-instance room bus.
 *
 * Every gateway is a replica of the rooms its clients are in. Redis is the
 * ordering point for edits: a gateway publishes a batch once, Redis assigns
 * the room sequence and fans it back to every subscribed instance, and each
 * instance applies exactly that sequence in exactly that order. That keeps
 * replicas convergent and makes `seq` a single room-wide watermark rather
 * than a per-process counter.
 */
export interface OpsPublication {
  roomId: string;
  /** The originating connection, so its gateway can acknowledge after fan-out. */
  sessionId: string;
  /** Every id in the original batch, including duplicates. */
  ackIds: string[];
  ops: readonly OpEnvelope[];
}

export interface OpsMessage extends OpsPublication {
  t: 'ops';
  origin: string;
  seq: number;
  ops: OpEnvelope[];
}

export interface PresenceMessage {
  t: 'presence';
  origin: string;
  roomId: string;
  /** The connection whose presence changed. */
  sessionId: string;
  /** `null` removes the session from the other instances' rosters. */
  member: RoomMember | null;
}

export type BusMessage = OpsMessage | PresenceMessage;
export type BusHandler = (message: BusMessage) => void;

export interface RoomBus {
  readonly kind: 'redis' | 'memory';
  /** Distinguishes this process from the other gateways on the bus. */
  readonly instanceId: string;
  /**
   * Assigns the next room-wide sequence and publishes the batch atomically.
   * `floor` is the caller's watermark; a missing or lower Redis counter is
   * raised to it before the increment, so a restored Redis cannot reuse a
   * sequence that is already in a snapshot or operation log.
   */
  publishOps(publication: OpsPublication, floor: number): Promise<number>;
  publishPresence(roomId: string, sessionId: string, member: RoomMember | null): Promise<void>;
  subscribe(handler: BusHandler): void;
  close(): Promise<void>;
}

const CHANNEL_PREFIX = 'syncanvas:room:';

function channel(roomId: string): string {
  return `${CHANNEL_PREFIX}${roomId}`;
}

function sequenceKey(roomId: string): string {
  return `${CHANNEL_PREFIX}${roomId}:seq`;
}

// SEED + INCR + PUBLISH has to be one script: if two gateways allocated
// sequence numbers in separate commands, their publishes could overtake each
// other and every subscriber would see a different order. Seeding also raises
// a stale counter (for example after Redis restored an older snapshot) to the
// caller's watermark; lowering an existing counter would reuse a sequence.
const PUBLISH_SCRIPT = `
local floor = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1]))
if not current or current < floor then
  redis.call('SET', KEYS[1], tostring(floor))
end
local seq = redis.call('INCR', KEYS[1])
local payload = string.gsub(ARGV[2], ARGV[3], tostring(seq), 1)
redis.call('PUBLISH', KEYS[2], payload)
return seq
`;

class RedisRoomBus implements RoomBus {
  readonly kind = 'redis' as const;
  readonly instanceId: string;

  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly logger: Pick<Console, 'warn'>;
  private handler: BusHandler | null = null;
  private readonly buffered: BusMessage[] = [];
  private closing = false;

  constructor(url: string, instanceId: string, logger: Pick<Console, 'warn'>) {
    this.instanceId = instanceId;
    this.logger = logger;
    this.publisher = createClient({ url });
    this.subscriber = createClient({ url });
    this.publisher.on('error', (error: unknown) => {
      if (!this.closing) this.logger.warn('Redis publisher error:', error);
    });
    this.subscriber.on('error', (error: unknown) => {
      if (!this.closing) this.logger.warn('Redis subscriber error:', error);
    });
  }

  async connect(): Promise<void> {
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.pSubscribe(`${CHANNEL_PREFIX}*`, (raw: string) => {
      this.receive(raw);
    });
  }

  async publishOps(publication: OpsPublication, floor: number): Promise<number> {
    // A per-call marker means user-controlled ids cannot collide with the
    // sequence slot and be replaced by the Lua script.
    // Keep the marker free of Lua pattern metacharacters (a UUID's hyphens
    // are pattern repetition operators, not literals).
    const placeholder = `__SYNCANVAS_SEQUENCE_${randomUUID().replaceAll('-', '')}__`;
    const message: Omit<OpsMessage, 'seq'> & { seq: string } = {
      t: 'ops',
      origin: this.instanceId,
      roomId: publication.roomId,
      sessionId: publication.sessionId,
      ackIds: publication.ackIds,
      ops: [...publication.ops],
      seq: placeholder,
    };
    const result = await this.publisher.eval(PUBLISH_SCRIPT, {
      keys: [sequenceKey(publication.roomId), channel(publication.roomId)],
      arguments: [String(Math.max(0, floor)), JSON.stringify(message), `"${placeholder}"`],
    });
    return Number(result);
  }

  async publishPresence(
    roomId: string,
    sessionId: string,
    member: RoomMember | null,
  ): Promise<void> {
    const message: PresenceMessage = {
      t: 'presence',
      origin: this.instanceId,
      roomId,
      sessionId,
      member,
    };
    await this.publisher.publish(channel(roomId), JSON.stringify(message));
  }

  subscribe(handler: BusHandler): void {
    this.handler = handler;
    while (this.buffered.length > 0) {
      const message = this.buffered.shift();
      if (message) handler(message);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.handler = null;
    this.buffered.length = 0;
    await Promise.all([
      this.publisher.isOpen ? this.publisher.quit() : Promise.resolve(),
      this.subscriber.isOpen ? this.subscriber.quit() : Promise.resolve(),
    ]).catch((error: unknown) => {
      this.logger.warn('Could not close the Redis bus cleanly:', error);
    });
  }

  private receive(raw: string): void {
    let message: BusMessage | null = null;
    try {
      const parsed = JSON.parse(raw) as BusMessage;
      if (parsed && (parsed.t === 'ops' || parsed.t === 'presence')) message = parsed;
    } catch {
      this.logger.warn('Ignoring an unreadable Redis room message.');
    }
    if (!message) return;
    if (this.handler) {
      this.handler(message);
    } else {
      // The websocket server attaches its handler immediately after the bus
      // connects. Keep that tiny startup window from losing a frame.
      this.buffered.push(message);
      if (this.buffered.length > 1_000) this.buffered.shift();
    }
  }
}

/**
 * The shared exchange behind a set of `MemoryRoomBus` endpoints.
 *
 * Production uses Redis, where every process has its own client and a unique
 * instance id. Tests need the same topology inside one process: a single hub
 * assigns the room sequences and every endpoint gets each message once.
 */
export class MemoryRoomBusHub {
  private readonly listeners = new Set<(message: BusMessage) => void>();
  private readonly sequences = new Map<string, number>();
  private closed = false;

  add(listener: (message: BusMessage) => void): void {
    this.listeners.add(listener);
  }

  remove(listener: (message: BusMessage) => void): void {
    this.listeners.delete(listener);
  }

  nextSequence(roomId: string, floor: number): number {
    const seq = Math.max(this.sequences.get(roomId) ?? 0, floor) + 1;
    this.sequences.set(roomId, seq);
    return seq;
  }

  dispatch(message: BusMessage): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(message);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.sequences.clear();
  }
}

/**
 * An in-process endpoint with the same contract as Redis.
 *
 * Tests use two endpoints (with different instance ids) to run two real
 * gateways without a broker; a production gateway should use Redis so separate
 * processes can hear each other.
 */
export class MemoryRoomBus implements RoomBus {
  readonly kind = 'memory' as const;
  readonly instanceId: string;
  private readonly hub: MemoryRoomBusHub;
  private handler: BusHandler | null = null;
  private readonly buffered: BusMessage[] = [];
  private readonly receive = (message: BusMessage): void => {
    if (this.handler) {
      this.handler(message);
    } else {
      this.buffered.push(message);
      if (this.buffered.length > 1_000) this.buffered.shift();
    }
  };

  constructor(instanceId = `mem_${randomUUID().slice(0, 8)}`, hub = new MemoryRoomBusHub()) {
    this.instanceId = instanceId;
    this.hub = hub;
    this.hub.add(this.receive);
  }

  async publishOps(publication: OpsPublication, floor: number): Promise<number> {
    const seq = this.hub.nextSequence(publication.roomId, floor);
    const message: OpsMessage = {
      t: 'ops',
      origin: this.instanceId,
      roomId: publication.roomId,
      sessionId: publication.sessionId,
      ackIds: [...publication.ackIds],
      ops: [...publication.ops],
      seq,
    };
    // Deliberately synchronous and insertion-ordered: tests get deterministic
    // fan-out, and the gateway handler only enqueues the work.
    this.hub.dispatch(message);
    return seq;
  }

  async publishPresence(
    roomId: string,
    sessionId: string,
    member: RoomMember | null,
  ): Promise<void> {
    const message: PresenceMessage = {
      t: 'presence',
      origin: this.instanceId,
      roomId,
      sessionId,
      member,
    };
    this.hub.dispatch(message);
  }

  subscribe(handler: BusHandler): void {
    this.handler = handler;
    while (this.buffered.length > 0) {
      const message = this.buffered.shift();
      if (message) handler(message);
    }
  }

  async close(): Promise<void> {
    this.handler = null;
    this.buffered.length = 0;
    this.hub.remove(this.receive);
  }
}

export interface CreateRoomBusOptions {
  url?: string;
  instanceId?: string;
  logger?: Pick<Console, 'warn'>;
}

/**
 * Connects to Redis when a URL is configured and reachable.
 *
 * A missing broker is not fatal: one gateway still works as a complete
 * standalone product. The caller reports the bus kind in `/healthz`, so a
 * scaled deployment can be verified instead of silently believing it is
 * clustered.
 */
export async function createRoomBus(options: CreateRoomBusOptions = {}): Promise<RoomBus | null> {
  const url = options.url?.trim();
  if (!url) return null;

  const logger = options.logger ?? console;
  const instanceId = options.instanceId?.trim() || `gw_${randomUUID().slice(0, 8)}`;
  const bus = new RedisRoomBus(url, instanceId, logger);
  try {
    await bus.connect();
    return bus;
  } catch (error) {
    await bus.close();
    logger.warn(
      `Could not reach Redis (${(error as Error).message}); running without cross-instance fan-out.`,
    );
    return null;
  }
}
