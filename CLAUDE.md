# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a monorepo orchestrator for a point-of-sale (POS) system. The actual service code lives in three Git submodules:

- `selling-point-auth/` — NestJS authentication service (JWT issuance + forward auth validation)
- `selling-point-api/` — NestJS GraphQL API (business logic: products, customers, sales, invoices)
- `selling-point-admin-dashboard/` — React SPA admin UI (Webpack, Tailwind, XState, Navi routing)

A shared `selling-point-db/` submodule (nested inside auth and api) holds the Prisma schema and migrations used by both backend services.

## Running the Stack

```bash
# Start all services
docker-compose up -d

# Update all submodules to latest
git submodule update --recursive --remote
```

**First-time setup:**
1. Generate RSA keys for JWT in `selling-point-auth/src/` (see `selling-point-auth/README.md`)
2. Create `.env` in `selling-point-admin-dashboard/` (can be empty)
3. Create `.env` in repo root from `.env.example` (requires `NGROK_URL` and `NGROK_AUTHTOKEN`)

## Service Commands (run inside each submodule)

```bash
# Development (hot reload)
npm run start:dev

# Tests
npm test               # unit tests
npm run test:e2e       # e2e tests (jest-e2e.json config)
npm run test:cov       # coverage

# Lint / format
npm run lint           # eslint --fix
npm run format         # prettier --write

# Admin dashboard only
npm start              # webpack-dev-server + file watcher
npm run build          # production webpack build
```

## Architecture

### Request Flow

All traffic enters through **Traefik v2.5** on port 80:

| Path prefix | Routes to | Notes |
|-------------|-----------|-------|
| `/auth` | `auth:3000` | No forward auth (is the auth service) |
| `/api` | `api:3000` | Forward auth middleware applied |
| `/` | `admin-dashboard:3000` | Forward auth middleware applied |

**Forward auth**: Traefik sends every non-auth request to `http://auth:3000/auth/authorize`. The auth service decodes the JWT and returns user context headers to Traefik, which forwards them to the destination service.

**Circuit breaker**: Traefik trips the breaker when 50th-percentile latency exceeds 10 seconds.

### Auth Service (`selling-point-auth`)

- Issues JWTs at `POST /auth/token` (username + password)
- Validates JWTs at `GET /auth/authorize` (called by Traefik forward auth)
- Uses CASL for ability/scope definitions (`src/scope/`)
- Guards: `JwtAuthGuard` (all routes), `ScopeGuard` (ability enforcement); bypass with `@Public()` decorator
- Pino-based logging via `LoggerService`

### API Service (`selling-point-api`)

- GraphQL endpoint at `/api/graphql`
- Resolvers organized per entity in `src/resolvers/{entity}/`
- Decoded JWT context (userId, scope, language) available in all resolvers
- Auto-generated types in `src/generated/` — do not edit manually

### Admin Dashboard (`selling-point-admin-dashboard`)

- **Routing**: Navi (declarative, lazy-loaded routes in `src/routes/`)
- **State**: XState state machines (`src/stateMachines/`)
- **Styling**: Tailwind CSS + SCSS
- **i18n**: react-intl
- Communicates with backend via Axios; JWT stored and decoded via `jwt-decode`

### Database

- MySQL 8.3, shared between auth and api services
- Prisma ORM with schema in `selling-point-db/` submodule
- Run Prisma commands from within `selling-point-auth/` or `selling-point-api/` (both have `selling-point-db` as a nested submodule)

## Observability

| Service | URL |
|---------|-----|
| Traefik dashboard | http://localhost:8080 |
| Jaeger tracing | http://localhost:16686 |
| Metabase analytics | http://localhost:3001 |
| ngrok inspector | http://localhost:4040 |

## Key Environment Variables

**Auth service** (`IGNORE_ENV_FILE=true` in Docker — values injected directly):
- `DATABASE_URL` — MySQL connection string
- `PASSWORD_SALT` — bcrypt salt for password hashing

**Root `.env`** (for docker-compose):
- `NGROK_URL` — static ngrok domain
- `NGROK_AUTHTOKEN` — ngrok auth token

## Submodule Workflow

Changes to service code must be committed inside the respective submodule repo first, then the parent repo updated to point to the new submodule commit. The parent repo (`selling-point-reverse-proxy`) only contains `docker-compose.yaml`, `mysql-init/`, and orchestration config — no application logic.
