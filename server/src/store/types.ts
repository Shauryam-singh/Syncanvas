import type { OpEnvelope, RoomRole, SerializedDoc } from '@syncanvas/shared';

/** A signed-in user. Guest auth creates one on first contact. */
export interface User {
  id: string;
  displayName: string;
  createdAt: Date;
}

/** A room. `documents` is the persisted name for what the wire calls a room. */
export interface DocumentRecord {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
}

export interface DocumentSummary {
  document: DocumentRecord;
  role: RoomRole;
}

export interface SnapshotRecord {
  seq: number;
  /** The full CRDT document, including tombstones, registers and seen ids. */
  doc: SerializedDoc;
}

/**
 * Everything the gateway needs to persist.
 *
 * The interface is deliberately small and async: the memory implementation
 * resolves immediately, the Postgres one talks to the pool. Rooms keep the
 * hot merge path synchronous — persistence is appended after the merge.
 */
export interface Store {
  readonly kind: 'memory' | 'postgres';

  createUser(displayName: string): Promise<User>;
  user(id: string): Promise<User | null>;

  createDocument(input: { id: string; name: string; ownerId: string }): Promise<DocumentRecord>;
  document(id: string): Promise<DocumentRecord | null>;
  allDocuments(): Promise<DocumentRecord[]>;
  documentsFor(userId: string): Promise<DocumentSummary[]>;

  membership(documentId: string, userId: string): Promise<RoomRole | null>;
  /**
   * Adds a membership (or upgrades a viewer to an editor) without ever
   * downgrading an existing role. Returns the effective role.
   */
  grant(documentId: string, userId: string, role: Exclude<RoomRole, 'owner'>): Promise<RoomRole>;

  appendOperations(
    documentId: string,
    seq: number,
    envelopes: readonly OpEnvelope[],
  ): Promise<void>;
  /** Operations accepted after the snapshot watermark `afterSeq`. */
  loadOperations(documentId: string, afterSeq: number): Promise<OpEnvelope[]>;
  latestSeq(documentId: string): Promise<number>;

  saveSnapshot(documentId: string, seq: number, doc: SerializedDoc): Promise<void>;
  latestSnapshot(documentId: string): Promise<SnapshotRecord | null>;

  close(): Promise<void>;
}

/** Ids are short and URL-safe; prefixes make logs and tokens readable. */
export function newId(prefix: string): string {
  const random = globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  return `${prefix}_${random}`;
}
