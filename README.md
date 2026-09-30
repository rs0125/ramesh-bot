# WareOnGo WhatsApp worker

Standalone TypeScript + Prisma service for the sales team's WhatsApp bot. It replies `hello` to text DMs and real group @mentions. Group replies stay in the triggering group; this scaffold has no arbitrary-send endpoint.

The Next.js admin lives in the **separate [ramesh-bot-admin repository](https://github.com/rs0125/ramesh-bot-admin)**, with its own dependencies, lockfile and Vercel workflow. These local checkouts are named `baileys-ramesh` and `baileys-ramesh-admin`; cloned directories can use any names. It talks to this worker through the authenticated `/v1` HTTP API. Neither project imports or builds the other.

## Local setup

Use Node.js 22.16 or newer within the Node 22 release line:

```sh
npm ci
npm run setup:local
npm run prisma:generate
npm run db:migrate
npm run dev
```

The worker listens on `127.0.0.1:3011` and starts disconnected. `setup:local` fills missing secrets in `.env` without printing them or replacing existing values. Configure the admin separately; its `WORKER_API_TOKEN` must match this worker's token. The admin normally runs at `http://127.0.0.1:3010`.

When ready for a real-account test, use **Connect WhatsApp** in the admin and scan the QR in WhatsApp's Linked devices screen. Current automated checks use simulated events only. Disconnect retains the paired credentials and remains in effect across restarts; reconnect reuses those credentials. `WHATSAPP_AUTO_CONNECT` controls startup only until an operator preference is saved.

## Structure

```text
src/
  app/                     Composition and process lifecycle
  config/                  Validated environment
  contracts/               Worker-owned v1 API types
  modules/greetings/       Eligibility, durable claim, fixed hello reply
  infrastructure/
    whatsapp/              SDK adapter, mapping, connection/retry management
    database/              Prisma repositories and encrypted auth storage
    http/                  Authenticated control/session API, bounded bodies
  lib/                     Logging and bounded serial queue
prisma/                    Bot-owned SQLite schema and migrations
scripts/                   Local setup
tests/                    Unit/integration tests and fake WhatsApp process
deploy/                   EC2/SSM templates, release helper and rollback tests
.github/workflows/         Independent worker CI and EC2 CD
```

Each module has an entry comment describing its responsibility. Imports do not open connections; `src/index.ts` owns startup. Add future features under `modules/` and keep transport/storage dependencies in adapters.

## Behavior and guarantees

- Accepts recent DMs and genuine group mentions, including phone-number and LID addressing. Ignores history batches, own messages, reactions, non-text system traffic and stale messages.
- Claims each chat/message pair in SQLite before sending. Duplicate events and uncertain deliveries do not trigger retries. This is **at most one send attempt**, not a guarantee of delivery. Claims expire after 30 days; the normal eligibility window is five minutes.
- Persists Baileys credentials and Signal keys in Prisma using AES-256-GCM with authenticated row identities. Atomic key batches fail closed; a storage failure closes the socket.
- Bounds the message/control queues and HTTP bodies, caps send time, retries transient connection failures, drains accepted work on shutdown, and clears obsolete QR codes.
- Persists admin session hashes, logout revocation and login limits centrally, so Vercel instances share them. The admin password is an operational control; employee/CRM authorization remains a plan.

See [.env.example](.env.example) for settings. Back up `AUTH_ENCRYPTION_KEY` separately from the SQLite database; losing it prevents reuse of the paired session. Keep one active worker per linked account. This schema is owned by the bot and must not be applied to the CRM database.

## Checks and deployment

```sh
npm run check
```

This runs schema validation, TypeScript, real SQLite/HTTP integration tests, deployment guard/rollback tests, the worker build and formatting. Tests use temporary databases and synthetic credentials. They never connect to WhatsApp.

The admin's browser suite can also test this real worker with a fake transport:

```sh
cd ../baileys-ramesh-admin
BOT_WORKER_DIR=../baileys-ramesh npm run test:e2e
```

Build the admin and install Playwright Chromium first, as described in its README. `BOT_WORKER_DIR` is an optional test setting, not a runtime dependency.

CI/CD follows the neighboring `warehouse-enricher` repository: successful main CI → GitHub OIDC → restricted SSM document → exact tested commit → stable health/authentication checks and rollback. CD remains disabled until `EC2_DEPLOY_ENABLED=true` is configured. No cloud infrastructure or WhatsApp account has been deployed or paired by this work.

Read [deployment and recovery](docs/deployment-vercel-ec2.md), [architecture/API](docs/architecture.md), and the preserved [product context and rough authorization plan](CONTEXT.md).

Dependency note: the Prisma config dependency overrides `deepmerge-ts` to patched version 8 for [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Schema generation, migration deployment and migration diff are covered by local checks; remove the override when the upstream Prisma dependency includes the fix.
