import type { OpEnvelope, RoomRole, SerializedDoc } from '@syncanvas/shared';
import {
  newId,
  type DocumentRecord,
  type DocumentSummary,
  type SnapshotRecord,
  type Store,
  type User,
} from './types.js';

type MemoryUser = User;
type MemoryDocument = DocumentRecord;
interface StoredOp {
  seq: number;
  envelope: OpEnvelope;
}

/**
 * The in-memory store.
 *
 * It is the default when no database is configured (tests, the browser smoke
 * test, local hacking). Access control and room semantics are identical to
 * Postgres; only durability differs.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private readonly users = new Map<string, MemoryUser>();
  private readonly documents = new Map<string, MemoryDocument>();
  private readonly memberships = new Map<string, Map<string, RoomRole>>();
  private readonly ops = new Map<string, StoredOp[]>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly snapshots = new Map<string, SnapshotRecord[]>();

  async createUser(displayName: string): Promise<User> {
    const user: User = {
      id: newId('user'),
      displayName: displayName.trim().slice(0, 40) || 'Guest',
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async user(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async createDocument(input: {
    id: string;
    name: string;
    ownerId: string;
  }): Promise<DocumentRecord> {
    const document: DocumentRecord = {
      id: input.id,
      name: input.name.trim().slice(0, 80) || 'Untitled room',
      ownerId: input.ownerId,
      createdAt: new Date(),
    };
    this.documents.set(document.id, document);
    this.memberships.set(document.id, new Map([[input.ownerId, 'owner']]));
    return document;
  }

  async document(id: string): Promise<DocumentRecord | null> {
    return this.documents.get(id) ?? null;
  }

  async allDocuments(): Promise<DocumentRecord[]> {
    return [...this.documents.values()];
  }

  async documentsFor(userId: string): Promise<DocumentSummary[]> {
    const summaries: DocumentSummary[] = [];
    for (const [documentId, members] of this.memberships) {
      const role = members.get(userId);
      const document = this.documents.get(documentId);
      if (role && document) summaries.push({ document, role });
    }
    return summaries.sort(
      (a, b) => b.document.createdAt.getTime() - a.document.createdAt.getTime(),
    );
  }

  async membership(documentId: string, userId: string): Promise<RoomRole | null> {
    return this.memberships.get(documentId)?.get(userId) ?? null;
  }

  async grant(
    documentId: string,
    userId: string,
    role: Exclude<RoomRole, 'owner'>,
  ): Promise<RoomRole> {
    const members = this.memberships.get(documentId) ?? new Map<string, RoomRole>();
    this.memberships.set(documentId, members);
    const current = members.get(userId);
    // Never downgrade: a viewer invite cannot take an editor's rights away.
    const effective = current === 'owner' || current === 'editor' ? current : role;
    members.set(userId, effective);
    return effective;
  }

  async appendOperations(
    documentId: string,
    seq: number,
    envelopes: readonly OpEnvelope[],
  ): Promise<void> {
    const stored = this.ops.get(documentId) ?? [];
    const seen = this.seen.get(documentId) ?? new Set<string>();
    for (const envelope of envelopes) {
      if (seen.has(envelope.id)) continue;
      seen.add(envelope.id);
      stored.push({ seq, envelope });
    }
    this.ops.set(documentId, stored);
    this.seen.set(documentId, seen);
  }

  async loadOperations(documentId: string, afterSeq: number): Promise<OpEnvelope[]> {
    return (this.ops.get(documentId) ?? [])
      .filter((entry) => entry.seq > afterSeq)
      .map((entry) => entry.envelope);
  }

  async latestSeq(documentId: string): Promise<number> {
    return (this.ops.get(documentId) ?? []).reduce((max, entry) => Math.max(max, entry.seq), 0);
  }

  async saveSnapshot(documentId: string, seq: number, doc: SerializedDoc): Promise<void> {
    const snapshots = this.snapshots.get(documentId) ?? [];
    snapshots.push({ seq, doc });
    this.snapshots.set(documentId, snapshots);
  }

  async latestSnapshot(documentId: string): Promise<SnapshotRecord | null> {
    const snapshots = this.snapshots.get(documentId) ?? [];
    return snapshots[snapshots.length - 1] ?? null;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
