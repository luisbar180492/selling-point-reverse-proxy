# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Docker Compose orchestration repository for a selling-point POS system. It wires together three Git submodules via a Traefik v2 reverse proxy, plus MySQL, Metabase analytics, Jaeger tracing, and an ngrok tunnel.

## Initial Setup

```bash
# Clone with all submodules
git clone --recursive git@personal-gitlab:luisbar/selling-point-reverse-proxy.git

# Generate EC JWT keys (required for auth service)
cd selling-point-auth/src
openssl ecparam -name secp256k1 -genkey -noout -out private.pem
openssl ec -in private.pem -pubout > public.pem

# Create .env for admin dashboard (can be empty)
touch selling-point-admin-dashboard/.env

# Create root .env from example (needed for ngrok)
cp .env.example .env  # then fill in NGROK_AUTHTOKEN and NGROK_URL

# Start all services
docker-compose up -d
```

## Updating Submodules

```bash
git submodule update --recursive --remote
```

## Service Architecture

Traefik listens on port 80 and routes by path prefix:
- `/api/*` → `selling-point-api` (NestJS + GraphQL + Prisma), port 3000 internally. Auth middleware (`forwardauth`) validates every request against `http://auth:3000/auth/authorize`.
- `/auth/*` → `selling-point-auth` (NestJS REST + Swagger), port 3000 internally. No auth middleware — this is the identity provider.

Other services:
- `selling-point-admin-dashboard` — React + Webpack + XState + Tailwind. Exposed on port 3000 on the host.
- `selling-point-mysql` — MySQL 8.3. Init scripts in `mysql-init/` create a `selling_point_analytics` DB and a `metabase` user.
- `selling-point-metabase` — Metabase v0.56 on port 3001. Connects to the analytics database.
- `selling-point-ngrok` — Tunnels Metabase publicly using `NGROK_URL` from `.env`.
- `selling-point-tracing` — Jaeger all-in-one on port 16686. Traefik sends traces here.
- Traefik dashboard: port 8080.

All services share a bridge network named `selling-point`. Traefik only exposes containers labelled `traefik.scope=selling-point`.

## Submodule Details

### selling-point-api (`selling-point-api/`)
- NestJS 8 with Apollo GraphQL (`schema.gql` is the source of truth for the schema).
- Prisma ORM — schema lives in `selling-point-db/schema.prisma` (a nested submodule).
- CASL for field-level authorization.
- Resolver modules per domain entity: `category`, `customer`, `invoice`, `product`, `sale`, `saleDetail`.
- Hot-reload in Docker via volume mount of `src/`.

```bash
# Inside selling-point-api/
npm run start:dev      # dev with watch
npm run test          # unit tests (Jest, *.spec.ts)
npm run test:e2e      # e2e tests
npm run lint          # ESLint + Prettier fix
npx prisma generate --schema selling-point-db/schema.prisma   # regenerate Prisma client
npx prisma migrate dev --schema selling-point-db/schema.prisma # create migration
```

### selling-point-auth (`selling-point-auth/`)
- NestJS 8 REST API with Passport JWT (EC secp256k1 keys at `src/private.pem` and `src/public.pem`).
- Exposes `/auth/authorize` — the Traefik forwardauth endpoint used to protect the API.
- Swagger UI available at `/auth/api`.
- Prisma for DB access; shares the same MySQL instance.
- Hot-reload via volume mount of `src/`.

```bash
# Inside selling-point-auth/
npm run start:dev
npm run test
npm run lint
```

### selling-point-admin-dashboard (`selling-point-admin-dashboard/`)
- React 17, Webpack 5, Tailwind 2, XState 4, react-navi router, react-intl i18n.
- Atomic design structure under `src/components/` (atoms, molecules, organisms, pages).
- A file watcher (`scripts/watcher/`) auto-generates routes when `.tsx`/`.md` files are added to `src/components/pages/private` or `src/components/pages/public`, and loads new i18n languages from `src/internationalization/languages/`.
- Env vars are loaded by Webpack (dotenv-webpack).

```bash
# Inside selling-point-admin-dashboard/
npm start             # runs watcher + webpack-dev-server in parallel
npm run build         # production build
npm test              # Jest tests
npm run lint          # ESLint
```

## Adding a New Field to the Schema

Follow the workflow documented in `.windsurf/rules/add-new-field-to-schema.md`:

1. Update `selling-point-api/selling-point-db/schema.prisma`.
2. Run `npx prisma generate` and `npx prisma migrate dev`.
3. Update `schema.gql`, resolvers in `src/resolvers/<entity>/`, validation in `src/common/validation/`.
4. Update frontend queries/mutations, TypeScript types, and UI components in `selling-point-admin-dashboard/`.
