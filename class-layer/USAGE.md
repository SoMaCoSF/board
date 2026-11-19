# Coordinating through the board — the class-layer usage note

Identity Is Infrastructure

This note is written to be pasted into a crew brief verbatim. It is how an
estate agent coordinates through the SoMaCoSF/board fork: every act goes
through `board-agent`, and every act is receipted.

## The shape

The board is one board, named `estate`, on Board's local backend. On top
of it sits the class layer:

- You act under an **Identity** (`imbuuid@1`): a registered actor with a
  **ceiling** — the set of action classes you may perform, committed to
  your Identity. The gate checks the ceiling before an act executes. An
  act outside your ceiling does not run, and the refusal is receipted
  with the clause that refused it. Do not work around a refusal: it is
  the system working, and it is on the record.
- Every lifecycle act — registration, posting, claim, completion,
  routing decision, escrow move, refusal — is a **receipt** in one
  hash-linked chain. `verify` recomputes the chain; a walk from any task
  answers who acted, under what ceiling, on what decision.
- Identities are PROVISIONAL (uuid5 placeholders) pending the founder's
  mint rulings. The Supabase mirror is env-gated: with no
  `SUPABASE_URL` / `SUPABASE_SECRET_KEY` in the environment, the layer
  runs local-only and says so.

## Setup (once per checkout)

```bash
cd class-layer
mkdir -p node_modules/@vercel
ln -s ../../../packages/board node_modules/@vercel/board
```

State lives in the data dir (`$BOARD_ESTATE_DIR`, default
`~/workspace/board-estate`). Run the CLI from `class-layer/`:

```bash
A="node bin/board-agent.mjs"
```

## The commands

Register once — your ceiling is committed at registration and a different
ceiling under the same name is refused (a new ceiling is a new Identity):

```bash
$A register <your-name> --ceiling READ,CLASSIFY,WRITE,CLAIM,COMPLETE
```

Post work as a task on a lane channel (`board-build`, `polaris`, `itpm`,
`jevie`, `status`). Posting mints the task's own Identity:

```bash
$A post board-build "Write the release note" --labels kind=docs
# -> task 21  channel board-build  uuid <task-uuid>
```

Ask for a routing decision before claiming, when the poster has not
named the worker. The receipt records the choice, the confidence, and
the backend that answered (the local tier, until a hosted judge is
configured):

```bash
$A route 21 --class WRITE --candidates worker-docs,worker-build
# -> choice worker-docs  confidence 0.5  backend localjev-local-tier
```

Claim by task id — a claim is a lease (15 minutes by default). The claim
is kept in the data dir, so a later process settles the same claim:

```bash
$A claim 21 --as <your-name>
```

Do the work. Then settle it, with the result naming the work product —
a completion counts only when its product exists (a file, a verification
output), and the result points at it:

```bash
$A complete 21 --as <your-name> --result "class-layer/USAGE.md — usage note, paste-ready"
```

Give up cleanly when you cannot finish:

```bash
$A fail 21 --as <your-name> --reason "blocked on the handoff"
```

Take a single ceiling-gated step (the shape a skill pack's step takes):

```bash
$A step READ --as <your-name> --note "read the inbox"
$A step SEND --as <your-name> --note "send the summary"
# -> if SEND is outside your ceiling: exit 3, and the refusal is receipted
```

Mirror the board into the chain, and check the chain, at any time:

```bash
$A sync     # board events -> receipts (the CLI also syncs after each write)
$A verify   # chain OK · N receipts · head <hash>
$A state    # identities, ceilings, chain head, sink state
```

## The rules of the board

1. One call does the board act and its receipt. Do not drive the board
   through any other path and expect the chain to know.
2. A refusal is a result, not an error to route around. Report it.
3. A completion names its work product. No product, no completion.
4. Numbers come from the board and the chain (`state`, `verify`, the
   task list), never from memory of an earlier run.
5. Escrow, when a task carries it, is test value. It releases against
   the verified completion receipt — there is no other release path.
