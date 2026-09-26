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
| Change DB schema | `npx prisma migrate dev --name <what-changed>` |
| Apply migrations (prod/CI) | `npx prisma migrate deploy` |

Schema changes go through **Prisma Migrate**, not `prisma db push` — every change must produce a file under `prisma/migrations/`. `db push` live-diffs the DB against `schema.prisma` and has actually deleted a hand-added generated column here once (nothing not declared in `schema.prisma` is safe under it); migrations don't have that failure mode. Some columns (e.g. `Product.searchVector`, a generated `tsvector`) are hand-written directly into a migration's `migration.sql` because Prisma's schema DSL can't express them — see `prisma/migrations/1_add_product_search_vector/`.

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
3. Read an existing spec in [`../docs/specs/`](../docs/specs/) (e.g. `catalog_spec.md`) side by side with its implementation to see how spec sections map to actual code.
4. Bring up the environment with `docker compose up -d` + `pnpm start:dev`, then hit an endpoint via Swagger to confirm the setup works before making changes.
5. Check recent commits (`git log --oneline -20`) to see current conventions and what's actively in flight.

## New Feature Workflow — Spec-Driven Development (mandatory)
This project enforces SDD via [`../.agents/skills/spec-driven-workflow/SKILL.md`](../.agents/skills/spec-driven-workflow/SKILL.md). Summary — do not skip steps:

1. **Write the spec first**, in `../docs/specs/<domain>_spec.md`. It must contain:
   - Business Flow (actors + purpose)
   - Use Cases split into Commands (writes) and Queries (reads)
   - A Mermaid sequence diagram (API → Controller → Command Handler → Domain Entity → Repository → Message Broker)
   - Acceptance Criteria in Given–When–Then (BDD) format
2. **Stop and get the spec approved** before writing any application code. No exceptions.
3. **Implement strictly against the approved spec** — command/query names, entity behavior, and acceptance criteria should trace 1:1 back to the spec.
4. **Changing existing logic?** Open the matching `*_spec.md` first, update the diagram/use cases/acceptance criteria to match the new requirement, get that re-approved, then change the code. Spec and code must never drift apart.

## Testing Strategy
- `*.spec.ts` — unit tests, no DB/network, runs fully in memory (`pnpm test`)
- `*.integration-spec.ts` — hits real Postgres/Redis (via Docker), verifies Prisma-generated SQL
- `test/*.e2e-spec.ts` — full HTTP flow via Supertest (`pnpm test:e2e`)

## Commit Convention
Conventional Commits, enforced by commitlint + a Husky pre-commit hook that lints and formats staged files automatically.
