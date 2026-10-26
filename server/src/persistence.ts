import {
  createDoc,
  createInitialScene,
  deserializeDoc,
  mergeEnvelopes,
  serializeDoc,
  type OpEnvelope,
  type SceneDoc,
} from '@syncanvas/shared';
import type { RoomRegistry } from './rooms.js';
import type { Store } from './store/types.js';

/**
 * Rebuilds every persisted room before the gateway starts accepting clients.
 *
 * A snapshot carries the whole CRDT document (registers, tombstones, RGA order
 * and seen ids), so reloading from it is equivalent to never having stopped.
 * Only operations after its watermark are replayed. If the snapshot is missing
 * or unreadable, the gateway falls back to the seeded scene plus the full log.
 */
export async function loadRooms(store: Store, registry: RoomRegistry): Promise<void> {
  for (const document of await store.allDocuments()) {
    const snapshot = await store.latestSnapshot(document.id);
    let doc: SceneDoc = createDoc(createInitialScene());
    let replayFrom = 0;
    if (snapshot) {
      try {
        doc = deserializeDoc(snapshot.doc);
        replayFrom = snapshot.seq;
      } catch {
        // Ignore a corrupt snapshot and replay the log; state is never guessed.
      }
    }
    const operations = await store.loadOperations(document.id, replayFrom);
    if (operations.length > 0) doc = mergeEnvelopes(doc, operations);
    const seq = Math.max(await store.latestSeq(document.id), snapshot?.seq ?? 0);
    registry.installRoom({ id: document.id, doc, seq });
  }
}

/**
 * Ensures the public sandbox room exists.
 *
 * The demo room is readable and editable by any signed-in user — it is the
 * "try it now" room linked from the README. Every other room requires a
 * membership or a signed invite.
 */
export async function ensureDemoRoom(
  store: Store,
  registry: RoomRegistry,
  roomId: string,
  name = 'Demo canvas',
): Promise<void> {
  if (!roomId) return;
  const existing = await store.document(roomId);
  if (!existing) {
    const owner = await store.createUser('Syncanvas demo');
    await store.createDocument({ id: roomId, name, ownerId: owner.id });
  }
  registry.ensureRoom(roomId);
}

export interface PersistenceOptions {
  /** Snapshot after this many accepted operations. */
  snapshotEvery?: number;
  /** …or after this much time has passed since the last snapshot. */
  snapshotIntervalMs?: number;
  logger?: Pick<Console, 'error'>;
}

interface RoomStats {
  operations: number;
  lastSnapshotAt: number;
}

/**
 * Writes the operation log and snapshots behind the live merge.
 *
 * Every room has its own serial queue, so a snapshot can never overtake the
 * operations it claims to cover. Failures are logged and dropped: a database
 * hiccup must not take the realtime room down.
 */
export class RoomPersistence {
  private readonly stats = new Map<string, RoomStats>();
  private readonly queue = new Map<string, Promise<void>>();
  private readonly snapshotEvery: number;
  private readonly snapshotIntervalMs: number;
  private readonly logger: Pick<Console, 'error'>;

  constructor(
    private readonly store: Store,
    private readonly registry: RoomRegistry,
    options: PersistenceOptions = {},
  ) {
    this.snapshotEvery = options.snapshotEvery ?? 100;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 60_000;
    this.logger = options.logger ?? console;
  }

  /** Appends newly accepted operations and maybe takes a snapshot. */
  append(roomId: string, seq: number, envelopes: readonly OpEnvelope[]): void {
    if (envelopes.length === 0) return;

    this.enqueue(roomId, () => this.store.appendOperations(roomId, seq, envelopes));

    const now = Date.now();
    const stats = this.stats.get(roomId) ?? { operations: 0, lastSnapshotAt: now };
    stats.operations += envelopes.length;
    this.stats.set(roomId, stats);

    if (
      stats.operations >= this.snapshotEvery ||
      now - stats.lastSnapshotAt >= this.snapshotIntervalMs
    ) {
      this.snapshot(roomId);
    }
  }

  /** Captures the whole CRDT document, tagged with the room watermark. */
  snapshot(roomId: string): void {
    const room = this.registry.room(roomId);
    if (!room) return;
    // Capture now: the queue may run later, after more operations are merged.
    const seq = room.seq;
    const doc = serializeDoc(room.doc);
    this.enqueue(roomId, () => this.store.saveSnapshot(roomId, seq, doc));
    this.stats.set(roomId, { operations: 0, lastSnapshotAt: Date.now() });
  }

  /** Waits for every queued write. Call before closing the store. */
  async flush(): Promise<void> {
    for (const room of this.registry.all()) {
      if (room.opsSinceSnapshot > 0 || (this.stats.get(room.id)?.operations ?? 0) > 0) {
        this.snapshot(room.id);
      }
    }
    await Promise.all([...this.queue.values()]);
  }

  private enqueue(roomId: string, task: () => Promise<void>): void {
    const previous = this.queue.get(roomId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.logger.error(`Persistence for room ${roomId} failed:`, error);
    });
    this.queue.set(roomId, next);
    void next.finally(() => {
      if (this.queue.get(roomId) === next) this.queue.delete(roomId);
    });
  }
}
