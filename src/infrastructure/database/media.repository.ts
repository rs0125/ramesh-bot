/** Private encrypted media. Test and production use different tables and database roles. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { authCipher } from './auth-store.js';
import {
  MAX_MEDIA_ITEMS,
  type MediaRecord,
  type MediaStore,
  type MediaUpload,
  type MediaExtraction,
} from '../../modules/media/media.types.js';
export class MediaRepository implements MediaStore {
  private cipher;
  private table: string;
  constructor(
    private pool: Pool,
    private namespace: string,
    key: string,
    mode: 'production' | 'capture',
  ) {
    this.cipher = authCipher(key);
    this.table = mode === 'capture' ? 'public."ramesh-test-media"' : 'public."ramesh-media"';
  }
  async put(owner: string, source: string, upload: MediaUpload, receivedAt?: Date) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `media:${this.namespace}`,
      ]);
      const digest = createHash('sha256').update(upload.bytes).update(upload.mime).digest('hex');
      const previous = (
        await db.query(
          `SELECT id,content_hash,expires_at FROM ${this.table} WHERE namespace=$1 AND owner_hash=$2 AND source_id=$3`,
          [this.namespace, owner, source],
        )
      ).rows[0];
      if (previous) {
        if (previous.content_hash !== digest || previous.expires_at <= new Date())
          throw new Error('MEDIA_SOURCE_CONFLICT');
        await db.query('COMMIT');
        return previous.id as string;
      }
      const quota = (
        await db.query(
          `SELECT count(*)::int AS total,count(*) FILTER (WHERE owner_hash=$2)::int AS owned,coalesce(sum(byte_length),0)::bigint AS bytes FROM ${this.table} WHERE namespace=$1 AND expires_at>clock_timestamp()`,
          [this.namespace, owner],
        )
      ).rows[0];
      if (
        quota.total >= 500 ||
        quota.owned >= 24 ||
        Number(quota.bytes) + upload.bytes.length > 512 * 1024 * 1024
      )
        throw new Error('MEDIA_QUOTA_EXCEEDED');
      const id = randomUUID();
      await db.query(
        `INSERT INTO ${this.table}(id,namespace,owner_hash,source_id,content_hash,byte_length,upload_encrypted,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,least(coalesce($8::timestamptz,clock_timestamp()),clock_timestamp()),
         least(coalesce($8::timestamptz,clock_timestamp()),clock_timestamp())+interval '24 hours')`,
        [
          id,
          this.namespace,
          owner,
          source,
          digest,
          upload.bytes.length,
          this.cipher.seal(`media-upload:${owner}`, id, upload),
          receivedAt ?? null,
        ],
      );
      await db.query('COMMIT');
      return id;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
  async findSource(owner: string, source: string): Promise<string | undefined> {
    const row = (
      await this.pool.query(
        `SELECT id FROM ${this.table} WHERE namespace=$1 AND owner_hash=$2 AND source_id=$3 AND expires_at>clock_timestamp()`,
        [this.namespace, owner, source],
      )
    ).rows[0];
    return row?.id;
  }
  async get(owner: string, ids?: string[]): Promise<MediaRecord[]> {
    const rows = (
      await this.pool.query(
        `SELECT id,owner_hash,source_id,state,created_at,expires_at,extract_encrypted,failure_code FROM ${this.table} WHERE namespace=$1 AND owner_hash=$2 AND expires_at>clock_timestamp() AND ($3::uuid[] IS NULL OR id=ANY($3)) ORDER BY created_at DESC,id DESC LIMIT $4`,
        [this.namespace, owner, ids ?? null, MAX_MEDIA_ITEMS],
      )
    ).rows.reverse();
    return Promise.all(
      rows.map(async (r) => {
        const extract = r.extract_encrypted
          ? this.cipher.open(`media-extract:${owner}`, r.id, r.extract_encrypted)
          : undefined;
        // Legacy rows stored only a string. The MIME remains inside the encrypted upload.
        const details: { text?: string; kind?: MediaRecord['kind']; truncated?: boolean } =
          extract && typeof extract === 'object' && 'version' in extract && extract.version === 1
            ? (extract as {
                version: 1;
                text?: string;
                kind?: MediaRecord['kind'];
                truncated?: boolean;
              })
            : { text: typeof extract === 'string' ? extract : undefined };
        let kind = details.kind;
        if (!kind && (typeof extract === 'string' || r.state === 'failed')) {
          const legacy = (
            await this.pool.query(
              `SELECT upload_encrypted FROM ${this.table} WHERE id=$1 AND namespace=$2 AND owner_hash=$3 AND expires_at>clock_timestamp()`,
              [r.id, this.namespace, owner],
            )
          ).rows[0];
          if (legacy) {
            const upload = this.cipher.open(
              `media-upload:${owner}`,
              r.id,
              legacy.upload_encrypted,
            ) as MediaUpload;
            kind = upload.mime.startsWith('audio/')
              ? 'audio'
              : upload.mime.startsWith('image/')
                ? 'image'
                : 'document';
          }
        }
        return {
          id: r.id,
          owner: r.owner_hash,
          source: r.source_id,
          state: r.state,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          kind,
          ...(details.text === undefined ? {} : { text: details.text }),
          ...(details.truncated ? { truncated: true } : {}),
          ...(r.failure_code ? { failure: r.failure_code } : {}),
        };
      }),
    );
  }
  async claim(owner: string, id: string): Promise<MediaRecord | null> {
    const token = randomUUID();
    const r = (
      await this.pool.query(
        `UPDATE ${this.table} SET state='processing',lease_token=$4,lease_until=clock_timestamp()+interval '100 seconds' WHERE id=$1 AND namespace=$2 AND owner_hash=$3 AND expires_at>clock_timestamp() AND (state='pending' OR (state='processing' AND lease_until<clock_timestamp())) RETURNING *`,
        [id, this.namespace, owner, token],
      )
    ).rows[0];
    return r
      ? {
          id,
          owner,
          source: r.source_id,
          state: r.state,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          token,
          upload: this.cipher.open(`media-upload:${owner}`, id, r.upload_encrypted) as MediaUpload,
        }
      : null;
  }
  async finish(owner: string, id: string, token: string, result: MediaExtraction) {
    await this.pool.query(
      `UPDATE ${this.table} SET state=$5,extract_encrypted=$6,failure_code=$7,lease_token=NULL,lease_until=NULL WHERE id=$1 AND namespace=$2 AND owner_hash=$3 AND lease_token=$4 AND state='processing' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`,
      [
        id,
        this.namespace,
        owner,
        token,
        'text' in result ? 'ready' : 'failed',
        this.cipher.seal(`media-extract:${owner}`, id, { version: 1, ...result }),
        'failure' in result ? result.failure : null,
      ],
    );
  }
  async clear(owner: string) {
    await this.pool.query(`DELETE FROM ${this.table} WHERE namespace=$1 AND owner_hash=$2`, [
      this.namespace,
      owner,
    ]);
  }
  async clean() {
    await this.pool.query(
      `DELETE FROM ${this.table} WHERE id IN(SELECT id FROM ${this.table} WHERE namespace=$1 AND expires_at<=clock_timestamp() LIMIT 200)`,
      [this.namespace],
    );
  }
}
