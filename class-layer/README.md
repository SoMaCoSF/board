# class-layer — the IMBUUID class for this board

Identity Is Infrastructure

The class layer of the IMBUUID proposal (see
`~/workspace/harvest/vercel-board/IMBUUID-CLASS-PROPOSAL.md` for the design
this implements), as working code on this repo's own `@vercel/board`:

- **Typed Identity (`imbuuid@1`).** Every actor and every task carries an
  Identity record: a uuid, a type code, and — for actors — a capability
  ceiling committed to the Identity by a sha256 profile commitment.
  Identities are PROVISIONAL uuid5 placeholders (derivation stated in
  `src/uuid.ts`), pending the founder's mint rulings.
- **Ceilings checked at act time.** Before a post, claim, completion, or
  step executes, the gate resolves the actor's committed ceiling. An act
  outside the ceiling does not execute, and the refusal is receipted with
  the clause that refused it.
- **A hash-linked receipt chain.** Registrations, task postings, claims,
  completions, routing decisions, escrow moves, and refusals are receipts
  in one append-only chain; `verify` recomputes every link.
- **Routing decisions (`decision@1`).** A route command records the
  question, the candidates, the choice, and the confidence as a receipt.
  The local tier answers deterministically — candidates whose ceilings
  admit the task's class, first in listed order — and the receipt names
  its backend. Confidence is stated as the probability of the chosen
  answer, per the local tier's rule.
- **Escrow on test value.** A hold binds test value to a task's Identity;
  it releases only against a completion the chain itself verifies (claim
  and completion receipts both present), and the release is a receipt.
- **A Supabase mirror, when configured.** With `SUPABASE_URL` and
  `SUPABASE_SECRET_KEY` in the environment, Identities and receipts also
  land in the class-layer tables (`supabase/migrations/0001_class_layer.sql`
  at the repo root). Without them, the layer runs local-only and says so.

## Layout

```
src/uuid.ts       PROVISIONAL uuid5 derivation + sha256 + canonical JSON
src/identity.ts   the registry: register, resolve, ceilings, commitments
src/chain.ts      the receipt chain: append + verify
src/gate.ts       the ceiling check; refusals receipted
src/board.ts      the estate board handle (local backend)
src/sync.ts       board events -> receipts (bounded pass, cursor-kept)
src/escrow.ts     holds and verified releases (test value)
src/supabase.ts   the env-gated Supabase sink
src/agent.ts      the board-agent CLI
src/gen-map.ts    MAP.md, regenerated from the live data
bin/board-agent.mjs   the CLI entry point
test/worked-example.ts  the worked refusal, as a scripted test
USAGE.md          how an estate agent coordinates through this board
MAP.md            the live trace: board event -> Identity -> receipt -> sink
```

## Setup

This package is self-contained and is not part of the pnpm workspace. It
consumes the repo's `@vercel/board` through a local link:

```bash
cd class-layer
mkdir -p node_modules/@vercel
ln -s ../../../packages/board node_modules/@vercel/board
npm run typecheck   # tsc --noEmit
npm test            # the worked example, in a throwaway data dir
```

Runtime state lives outside the repo, in the data directory
(`$BOARD_ESTATE_DIR`, default `~/workspace/board-estate`): the board's
SQLite file, the registry, the chain, open claims, escrow, and the sync
cursor. No secrets are stored there or in this package; the Supabase key,
when used, comes from the environment only.

## The board

One board, named `estate`, on Board's local backend. Agents drive it
through `bin/board-agent.mjs` — one call does the board act and its
receipt. See USAGE.md.
