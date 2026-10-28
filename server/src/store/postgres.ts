import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  isSerializedDoc,
  type OpEnvelope,
  type RoomRole,
  type SerializedDoc,
} from '@syncanvas/shared';
import {
  newId,
  type DocumentRecord,
  type DocumentSummary,
  type SnapshotRecord,
  type Store,
  type User,
} from './types.js';

interface UserRow {
  id: string;
  display_name: string;
  created_at: Date;
}

interface DocumentRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: Date;
}

interface DocumentSummaryRow extends DocumentRow {
  role: RoomRole;
}

interface SnapshotRow {
  seq: string | number;
  state: { doc?: unknown };
}

interface EnvelopeRow {
  envelope: OpEnvelope;
}

/**
 * Arbitrary application-wide key used only to serialize schema creation.
 *
 * Every gateway boots against the same fresh database. PostgreSQL's
 * `CREATE TABLE IF NOT EXISTS` is not safe under that race, so the whole
 * migration runs in a transaction holding this advisory lock.
 */
const SCHEMA_LOCK_KEY = 0x53594e43;

/**
 * Resolves the schema whether the process runs from `src` (tsx/vitest) or
 * from `dist` after a build.
 */
async function readSchema(): Promise<string> {
  const candidates = [
    new URL('./schema.sql', import.meta.url),
    new URL('../../src/store/schema.sql', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(fileURLToPath(candidate), 'utf8');
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Could not find store/schema.sql');
}

function toUser(row: UserRow): User {
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
}

function toDocument(row: DocumentRow): DocumentRecord {
  return { id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at };
}

/**
 * Postgres-backed store.
 *
 * The operation log is append-only and snapshots are additive, so the same
 * room can be rebuilt after a gateway restart: newest snapshot, then every
 * envelope after its watermark, folded through the same CRDT merge.
 */
export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;

  private readonly pool: pg.Pool;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  }

  /** Creates the schema if it is missing. Safe to call on every boot. */
  async initialize(): Promise<void> {
    const schema = await readSchema();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      await client.query(schema);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createUser(displayName: string): Promise<User> {
    const id = newId('user');
    const name = displayName.trim().slice(0, 40) || 'Guest';
    const result = await this.pool.query<UserRow>(
      `INSERT INTO users (id, display_name) VALUES ($1, $2)
       RETURNING id, display_name, created_at`,
      [id, name],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Postgres did not return the created user');
    return toUser(row);
  }

  async user(id: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT id, display_name, created_at FROM users WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? toUser(row) : null;
  }

  async renameUser(id: string, displayName: string): Promise<User | null> {
    const name = displayName.trim().slice(0, 40);
    if (!name) return this.user(id);
    const result = await this.pool.query<UserRow>(
      `UPDATE users SET display_name = $2
       WHERE id = $1
       RETURNING id, display_name, created_at`,
      [id, name],
    );
    const row = result.rows[0];
    return row ? toUser(row) : null;
  }

  async createDocument(input: {
    id: string;
    name: string;
    ownerId: string;
  }): Promise<DocumentRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<DocumentRow>(
        `INSERT INTO documents (id, name, owner_id) VALUES ($1, $2, $3)
         RETURNING id, name, owner_id, created_at`,
        [input.id, input.name.trim().slice(0, 80) || 'Untitled room', input.ownerId],
      );
      await client.query(
        `INSERT INTO memberships (document_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [input.id, input.ownerId],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) throw new Error('Postgres did not return the created document');
      return toDocument(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async document(id: string): Promise<DocumentRecord | null> {
    const result = await this.pool.query<DocumentRow>(
      'SELECT id, name, owner_id, created_at FROM documents WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? toDocument(row) : null;
  }

  async allDocuments(): Promise<DocumentRecord[]> {
    const result = await this.pool.query<DocumentRow>(
      'SELECT id, name, owner_id, created_at FROM documents ORDER BY created_at ASC',
    );
    return result.rows.map(toDocument);
  }

  async documentsFor(userId: string): Promise<DocumentSummary[]> {
    const result = await this.pool.query<DocumentSummaryRow>(
      `SELECT d.id, d.name, d.owner_id, d.created_at, m.role
         FROM documents d
         JOIN memberships m ON m.document_id = d.id
        WHERE m.user_id = $1
        ORDER BY d.created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({ document: toDocument(row), role: row.role }));
  }

  async membership(documentId: string, userId: string): Promise<RoomRole | null> {
    const result = await this.pool.query<{ role: RoomRole }>(
      'SELECT role FROM memberships WHERE document_id = $1 AND user_id = $2',
      [documentId, userId],
    );
    return result.rows[0]?.role ?? null;
  }

  async grant(
    documentId: string,
    userId: string,
    role: Exclude<RoomRole, 'owner'>,
  ): Promise<RoomRole> {
    // An invite upgrades a viewer to editor, but never downgrades anybody.
    const result = await this.pool.query<{ role: RoomRole }>(
      `INSERT INTO memberships (document_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = CASE
         WHEN memberships.role = 'owner' THEN 'owner'
         WHEN memberships.role = 'editor' THEN 'editor'
         WHEN EXCLUDED.role = 'editor' THEN 'editor'
         ELSE memberships.role
       END
       RETURNING role`,
      [documentId, userId, role],
    );
    const effective = result.rows[0]?.role;
    if (!effective) throw new Error('Postgres did not return the membership role');
    return effective;
  }

  async appendOperations(
    documentId: string,
    seq: number,
    envelopes: readonly OpEnvelope[],
  ): Promise<void> {
    // Keep well below Postgres' 65,535 parameter limit.
    const chunkSize = 500;
    for (let start = 0; start < envelopes.length; start += chunkSize) {
      const chunk = envelopes.slice(start, start + chunkSize);
      if (chunk.length === 0) continue;
      const values: unknown[] = [];
      const placeholders = chunk.map((envelope, index) => {
        const base = index * 7;
        values.push(
          documentId,
          envelope.id,
          envelope.actorId,
          seq,
          envelope.hlc.wall,
          envelope.hlc.counter,
          JSON.stringify(envelope),
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`;
      });
      await this.pool.query(
        `INSERT INTO operations
           (document_id, op_id, actor_id, seq, hlc_wall, hlc_counter, envelope)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (document_id, op_id) DO NOTHING`,
        values,
      );
    }
  }

  async loadOperations(documentId: string, afterSeq: number): Promise<OpEnvelope[]> {
    const result = await this.pool.query<EnvelopeRow>(
      `SELECT envelope FROM operations
        WHERE document_id = $1 AND seq > $2
        ORDER BY seq ASC, op_id ASC`,
      [documentId, afterSeq],
    );
    return result.rows.map((row) => row.envelope);
  }

  async latestSeq(documentId: string): Promise<number> {
    const result = await this.pool.query<{ seq: string | number }>(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM operations WHERE document_id = $1',
      [documentId],
    );
    return Number(result.rows[0]?.seq ?? 0);
  }

  async saveSnapshot(documentId: string, seq: number, doc: SerializedDoc): Promise<void> {
    await this.pool.query(
      'INSERT INTO snapshots (document_id, seq, state) VALUES ($1, $2, $3::jsonb)',
      [documentId, seq, JSON.stringify({ doc })],
    );
  }

  async latestSnapshot(documentId: string): Promise<SnapshotRecord | null> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT seq, state FROM snapshots
        WHERE document_id = $1
        ORDER BY seq DESC, id DESC
        LIMIT 1`,
      [documentId],
    );
    const row = result.rows[0];
    if (!row || !isSerializedDoc(row.state?.doc)) return null;
    return { seq: Number(row.seq), doc: row.state.doc };
  }

  async compactOperations(documentId: string, throughSeq: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM operations
        WHERE document_id = $1 AND seq <= $2`,
      [documentId, throughSeq],
    );
    return result.rowCount ?? 0;
  }
}
