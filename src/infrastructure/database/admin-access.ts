/** Shared admin sessions and atomic login limits for every Next.js instance. */
import type { PrismaClient } from '@prisma/client';

export interface AdminAccess {
  attempt(key: string): Promise<{ allowed: boolean; retryAfter: number }>;
  create(tokenHash: string, expiresAt: Date): Promise<void>;
  verify(tokenHash: string): Promise<boolean>;
  revoke(tokenHash: string): Promise<void>;
}

export class PrismaAdminAccess implements AdminAccess {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => number = Date.now,
  ) {}

  async attempt(key: string) {
    const now = this.now();
    const expiresAt = new Date(now + 60_000);
    const current = new Date(now);
    // UPSERT increments inside SQLite, so concurrent Vercel invocations cannot bypass the cap.
    const [bucket] = await this.db.$queryRaw<Array<{ attempts: number; expiresAt: Date }>>`
      INSERT INTO "LoginBucket" ("key", "attempts", "expiresAt") VALUES (${key}, 1, ${expiresAt})
      ON CONFLICT("key") DO UPDATE SET
        "attempts" = CASE WHEN "LoginBucket"."expiresAt" <= ${current} THEN 1 ELSE "LoginBucket"."attempts" + 1 END,
        "expiresAt" = CASE WHEN "LoginBucket"."expiresAt" <= ${current} THEN ${expiresAt} ELSE "LoginBucket"."expiresAt" END
      RETURNING "attempts", "expiresAt"`;
    if (!bucket) throw new Error('Could not record login attempt');
    return {
      allowed: bucket.attempts <= 10,
      retryAfter: Math.max(1, Math.ceil((new Date(bucket.expiresAt).getTime() - now) / 1000)),
    };
  }

  async create(tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.adminSession.create({ data: { tokenHash, expiresAt } });
  }

  async verify(tokenHash: string): Promise<boolean> {
    const row = await this.db.adminSession.findUnique({ where: { tokenHash } });
    return !!row && row.expiresAt.getTime() > this.now();
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.db.adminSession.deleteMany({ where: { tokenHash } });
  }

  async clean(): Promise<void> {
    const now = new Date(this.now());
    await this.db.$transaction([
      this.db.adminSession.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.db.loginBucket.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.db.greeting.deleteMany({
        where: { createdAt: { lt: new Date(this.now() - 30 * 86_400_000) } },
      }),
    ]);
  }
}
