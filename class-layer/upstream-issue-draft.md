# Upstream issue draft — for vercel/board (issue-first package)

Status: DRAFT ONLY. Nothing in this file has been posted anywhere. It is
the text prepared for the day an issue is filed, per the proposal's
issue-first posture (IMBUUID-CLASS-PROPOSAL.md §1.2, §4.2): the repo's
`pull_request_creation_policy` is collaborators-only, so the first
upstream act is a proposal a maintainer can evaluate in minutes, backed
by a working implementation they can run.

---

**Title:** Proposal: an identity class for actors — ceilings on claims, and a receipt chain over the event log

**Body:**

Two observations from building on Board, both from Board's own docs and
contract:

1. **A profile "has no access of its own."** Access attaches to
   principals, projects, and channels; the actor — the unit every event
   is attributed to — carries no rights of its own. An agent's claim
   rights derive from channel grants and assignment, never from a
   capability profile committed to the agent itself.

2. **The schema registry validates shape, not reference.** The format
   list includes `uuid`: a post can be checked to carry a string that
   parses as a UUID, but nothing checks what the UUID *is* — that it
   resolves to a registered identity, of the right type, with a record
   behind it.

The proposal is a class in the same registry, in three parts:

- **Typed identity for board objects.** A registered identity class
  under which an actor, task, claim, decision, or receipt carries a
  typed UUID whose type segment names what it is. Post-time validation
  gains semantics: a claim record whose actor ID resolves to a task-type
  identity fails the way a malformed body fails today.
- **Identity-committed ceilings on claims.** The actor's identity
  commits a capability ceiling (which channels, which task classes,
  what lease bounds). The claim flow checks the ceiling at claim time;
  a claim outside it is refused at claim time with the clause named,
  and the refusal is itself receipted. A delegated identity can narrow
  a ceiling, never widen it.
- **A receipt chain over the event log.** Each task-lifecycle event
  (created, claimed, renewed, completed, failed, refused, released)
  emits a receipt carrying the event's identity, the actor's identity,
  and the hash of the previous receipt. The log Board already keeps
  becomes a walkable audit chain: any task answers who acted, under
  what ceiling, on what decision — including the routing decision,
  recorded as a structured `decision@1` object (choice, confidence,
  distribution, and the backend that answered).

**A working implementation exists to evaluate.** The same semantics run
today as a plugin — middleware plus registered schemas on a self-hosted
board, no fork of the primitive:

- Repo: https://github.com/SoMaCoSF/board (branch `mission-control`,
  `class-layer/` — registry, gate, chain, adapter, CLI; `MAP.md` there
  is a trace generated from a live run: board event → task identity →
  receipt → store)
- The worked behavior: a task whose class exceeds the claiming actor's
  ceiling is refused at claim time; the refusal is receipted with its
  clause; the chain recomputes end to end (`verify`).

If the maintainers want the native form, it is a contract-level change
(`packages/board/src/contract/` — an optional `identity` block on the
actor, a class marker on schema registrations, ceiling checks at claim
time, receipt emission on lifecycle events), written to this repo's
contributing conventions and ready to file as a PR when a route for one
exists. If they do not, the plugin stands on its own and nothing here
asks the repo to carry it.

— SoMaCoSF
