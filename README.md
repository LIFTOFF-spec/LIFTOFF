# LIFTOFF

> Launch Fair. Build Stronger.

LIFTOFF is a token launchpad on Solana with automated buyback, burn, and liquidity reinforcement.
Launches run on Raydium LaunchLab through StonkFun, and graduated tokens trade on Raydium CPMM.

- Website: https://liftoff-fun.com
- Docs: https://liftoff-fun.com/docs
- X: https://x.com/LiftOffFun
- LIFTOFF token (CA): `F1qYV1KEi3J5kDSBnSfSyC9ZtduHE4iauhsErA3BQNnW`

> **Mainnet beta.** Launches, trades, and fees use real funds and cannot be undone. Not financial
> advice. Token prices can go to zero.

## How it works

1. **Launch**: a creator launches a token on a Raydium LaunchLab bonding curve. LIFTOFF is an
   interface and automation layer; it does not run its own bonding curve or exchange.
2. **Fees**: platform fees from trading are claimed and recorded in an append-only ledger.
3. **Buyback & burn**: workers use the claimed fees to buy the token back and burn it on-chain.
4. **Conviction Reserve & liquidity reinforcement**: part of the fees is held per token and, after
   graduation, deployed as additional liquidity.

Every number shown on the site is labelled with its source (on-chain, ledger, or estimate). See
[`docs/reserve-simulation.md`](docs/reserve-simulation.md) for the reserve model.

## Architecture

```
apps/
  web/       Next.js (App Router) + Tailwind: the website
  api/       Fastify REST API: auth (Sign-In With Solana, optional X), pairs, tokens, launch jobs, ledger, health
  worker/    BullMQ workers: launch engine, fee intake, buyback/burn, reserve, market indexer, monitor
  signer/    Signing service, the only process that can read the platform key
packages/
  shared/    API types, Zod schemas, fee and reserve configuration
  db/        Prisma schema and migrations (append-only ledger enforced by database triggers)
  solana/    Solana, LaunchLab, and CPMM transaction builders
deploy/      Docker Compose, Caddy, and scripts for the production server
```

### Security model

- No private key lives in this repository, the frontend, logs, or API responses. Real
  configuration is in a server-only `.env` (see the `*.example` files).
- Only `apps/signer` can sign. It accepts requests only for known jobs, checks each transaction
  against an allowlist, simulates it, verifies on-chain balances, and enforces daily limits. It can be
  paused in an emergency.
- The public API has no write access to the economic ledger; separate database roles are used for
  the API, workers, and signer.
- The economic ledger is append-only at the database level.

## Running locally (devnet)

Requirements: Node.js ≥ 22.12, pnpm 12, Docker.

```bash
pnpm install
cp .env.example .env      # never put a private key in this file
pnpm db:up                # Postgres + Redis via Docker Compose
pnpm db:migrate
pnpm db:seed              # devnet sample data
pnpm dev                  # web :3000, api :4000, signer 127.0.0.1:4100, launch worker
```

Launching requires `SIGNER_KEYPAIR_PATH` (a devnet keypair file stored outside the repo) and
`SIGNER_AUTH_TOKEN` in `.env`. Without them, the signer and workers refuse to start.

| Script           | What it does                        |
| ---------------- | ----------------------------------- |
| `pnpm dev`       | Run web, api, signer, and worker    |
| `pnpm build`     | Build all packages                  |
| `pnpm lint`      | ESLint                              |
| `pnpm typecheck` | TypeScript (strict)                 |
| `pnpm test`      | Vitest (needs Postgres running)     |
| `pnpm format`    | Prettier (`format:check` to verify) |

Code comments are mostly in Indonesian. Some comments refer to internal planning documents that
are not part of this repository. The production preflight check (`deploy.sh`) also depends on
private tooling that is not included.

## Disclaimer

LIFTOFF is not affiliated with StonkFun or Raydium. This software is provided as is, without
warranty. Using it on mainnet puts real funds at risk.
