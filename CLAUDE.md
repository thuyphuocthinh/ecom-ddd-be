# CLAUDE.md — ecom-api

Backend service for the Ecom e-commerce platform. NestJS + PostgreSQL + Prisma, built with Clean Architecture, DDD, and CQRS.

## Tech Stack
- Framework: NestJS (TypeScript, ESM)
- Database: PostgreSQL via Prisma (`@prisma/adapter-pg`)
- Message broker: RabbitMQ (work queues, pub/sub, DLQ, transactional outbox)
- Cache & locking: Redis (Lua scripts for atomic stock reservation, OTP, rate limiting)
- API docs: Swagger (OpenAPI)
- Testing: Vitest (unit / integration / e2e)
- Lint/format: oxlint + Prettier, enforced via Husky pre-commit + commitlint (Conventional Commits)

Full architecture write-up: [`../docs/architecture.md`](../docs/architecture.md) — read it before touching domain logic. It covers the 4-layer module structure, aggregate root rules, transactional outbox, two-phase stock reservation, and event-driven patterns.

## Local Environment
```bash
docker compose up -d   # Postgres :5432, Redis :6379, RabbitMQ :5672 (mgmt UI :15672)
pnpm install
pnpm start:dev          # NestJS watch mode
```

## Commands
| Purpose | Command |
|---|---|
| Dev server (watch) | `pnpm start:dev` |
| Build | `pnpm build` |
| Lint | `pnpm lint` |
| Unit tests | `pnpm test` |
| E2E tests | `pnpm test:e2e` |
| Coverage | `pnpm test:cov` |
| Change DB schema | edit `prisma/schema.prisma` and the baseline `migration.sql`, then rebuild the dev databases (see below) |
| Apply migrations (prod/CI) | `npx prisma migrate deploy` |
| Check the schema and the migration agree | `npx prisma migrate dev` (must answer "Already in sync") |

**Migrations — one baseline while the project is being built.** The whole database is described by ONE migration, `prisma/migrations/<timestamp>_init/`, not a new small file per added or dropped column. It is mostly what Prisma generates from `schema.prisma`, plus parts written by hand because Prisma's schema language cannot express them; each is marked `Hand-written` in the file: the `Product.searchVector` generated `tsvector` column (full-text search), the inventory `CHECK` constraints, and the partial unique index "one Google credential per user". Prisma's `migrate dev` does not notice these ("Already in sync" says nothing about them), so keep them when you edit the file, and after a big change compare the real structure of the database. To change the schema: edit `schema.prisma`, then edit the baseline `migration.sql` to match (`npx prisma migrate diff --from-schema <the old schema> --to-schema prisma/schema.prisma --script` prints the SQL for the difference), then rebuild the databases from it: `npx prisma migrate reset --force`, and again with `DATABASE_URL` pointing at `ecom_test` (this deletes their data; Prisma refuses to run `migrate reset` for an AI assistant unless the user consents, so the user runs it). Once the project holds real data, stop editing the baseline and add one new migration file per change as usual.

`Product.searchVector` is declared in `schema.prisma` as `Unsupported("tsvector")` with a `dbgenerated(...)` default, only so Prisma knows the column exists; without that declaration `migrate dev` generates a `DROP COLUMN` for it (that is how an older migration came to delete it, and why `migrate dev` once demanded a reset). Never use `prisma db push`: it ignores the hand-written parts.

## Project Structure
- `src/core/` — infrastructure plumbing only, never business logic. Organized by role: `domain/` (base DDD classes, shared exceptions, pure types — no framework deps), `http/` (filters, interceptors, shared DTOs, request logging), `infrastructure/` (Prisma, Redis, RabbitMQ, idempotency — external systems), `config/` (env validation), `utils/` (stateless helpers). `DatabaseModule`/`RedisModule`/`IdempotencyModule` are `@Global()` and imported once in `AppModule` — a feature module should never re-list `PrismaService` (or the other global services) in its own `providers`, that creates a second, disconnected instance.
- `src/modules/<bounded-context>/` — one folder per bounded context (`catalog`, `inventory`, `orders`, ...), each following:
  ```
  domain/          entities, value objects, domain exceptions, repository ports
  application/     commands (writes) and queries (reads) — CQRS
  infrastructure/  Prisma repository adapters, RabbitMQ publishers/consumers
  presentation/    REST controllers, DTOs
  ```
- Only the Aggregate Root gets a repository (e.g. `ProductRepository`, never `SkuRepository`). Child entities are only reachable through their root.

## Code Quality — Clean Code & SOLID (mandatory)
- **NestJS module files (`*.module.ts`) are wiring only** — imports, providers, controllers array. No functions, no regex, no business logic defined inline in a module file. If a module file needs a helper (a validator, an id resolver, a mapper), that helper gets its own file under `core/utils/`, `core/config/`, or the owning module's own layer, and the module file only imports and references it.
- **Single Responsibility per file/class**: a repository persists, a mapper translates, a handler orchestrates a use case, an entity holds domain rules. Don't fold a second responsibility into a class because it's convenient in the moment (e.g. don't validate input inside a repository, don't put domain logic inside a controller).
- **Depend on abstractions, not concretions**: application/command handlers depend on the `I*Repository` port from `domain/repositories`, never directly on `PrismaService` or a concrete `Prisma*Repository`.
- When reviewing your own diff before committing, check for logic that landed in the wrong layer (especially module/bootstrap files) and move it before asking for a commit.

## Onboarding — how to use AI when joining this project
1. Have the AI read [`../docs/architecture.md`](../docs/architecture.md) and this file first, then ask it to summarize the module boundaries in its own words. Verify it got the Aggregate Root rule and the CQRS command/query split right before trusting it with code.
2. Pick one existing bounded context (`src/modules/catalog` is the most complete) and ask the AI to trace one full flow end to end: controller → command handler → domain entity → repository → outbox/RabbitMQ. This teaches the real data flow faster than reading file by file.
3. Read an existing spec in `specs/features/` (e.g. `specs/features/catalog/spec.md`, `specs/features/auth-jwt-rbac/spec.md`) side by side with its implementation to see how spec sections map to actual code. `speckit-ai status` lists active works, ideas and finished features.
4. Bring up the environment with `docker compose up -d` + `pnpm start:dev`, then hit an endpoint via Swagger to confirm the setup works before making changes.
5. Check recent commits (`git log --oneline -20`) to see current conventions and what's actively in flight.

## New Feature Workflow — Spec-Driven Development (mandatory)
This project enforces SDD with the `speckit-ai` CLI (2.x) and the skills in `.agents/skills/` (`spec-create`, `spec-plan`, `spec-review`). Read `specs/_workflow.md` for the full cycle and gates. Summary — do not skip steps:

```
idea "X"                  → specs/ideas/x.md              (backlog, optional)
start "X" [--affects=a]   → specs/active/x/               (work in progress)
done                      → specs/features/<slug>/spec.md (finished; work files archived in specs/.history/)
```

1. **Write the spec first.** `npx speckit-ai start "<title>"` for a new feature, or `--affects=<feature>` to change an existing one, then write the spec in `specs/active/<name>/targets/<feature>.md` (structure from `specs/_template.md`). Besides the template sections, it must contain:
   - Business Flow (actors + purpose)
   - Use Cases split into Commands (writes) and Queries (reads)
   - A Mermaid sequence diagram (API → Controller → Command Handler → Domain Entity → Repository → Message Broker)
   - Acceptance Criteria in Given–When–Then format, one `### AC-n:` heading per criterion
2. **Stop and get the spec approved** before writing any application code. No exceptions.
3. **Implement strictly against the approved spec** — command/query names, entity behavior, and acceptance criteria should trace 1:1 back to the spec. Follow `plan.md` and `tasks.md` in the active work; tick tasks as you go.
4. **Changing existing logic?** Use `start --affects=<feature>` (it copies the current spec into `targets/`), update the diagram/use cases/acceptance criteria, get that re-approved, then change the code. Spec and code must never drift apart.
5. **Finish with the gates:** `npx speckit-ai lint`, then `npx speckit-ai done`. Never edit the `## Changelog` by hand, and never read or edit `specs/.history/`. Trivial bugfixes need only a clear commit message (see "Bugs and hotfixes" in `specs/_workflow.md`).

## Testing Strategy
- `*.spec.ts` — unit tests, no DB/network, runs fully in memory (`pnpm test`)
- `*.integration-spec.ts` — hits real Postgres/Redis (via Docker), verifies Prisma-generated SQL
- `test/*.e2e-spec.ts` — full HTTP flow via Supertest (`pnpm test:e2e`)

## Commit Convention
Conventional Commits, enforced by commitlint + a Husky pre-commit hook that lints and formats staged files automatically.
