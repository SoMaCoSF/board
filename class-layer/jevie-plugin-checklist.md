# Jevie plugin readiness checklist

Compiled 2026-11-19 from the Jevie fold-in map (SOM-DOC-10864,
`~/workspace/explorations/somacomarchy/JEVIE-FOLD-IN.md`). The plugin in
question is PR 1 of the IMBUUID proposal: the IMBUUID wrap as a Jevie
plugin — skill packs, decisions, and executor steps carrying typed
Identities, ceilings, and receipts; plugin-capable and toggleable.
Target: Vlad's repo when the handoff lands; built meanwhile against the
founder's own line (jev-use + the fold-in map). The founder has already
told Vlad the direction in his own words: build the UUID as a plugin he
publishes himself; adoption at will.

## Ready now — foldable from bundle evidence (fold-in grades)

- [x] **C1 — System One client contract.** The estate connector speaks
  the same protocol (POST api.typesafe.ai/v1/systemone, model
  jev-1.13.0). The plugin's decision calls ride this contract.
- [x] **C2 — LocalJev tier, as spec.** The estate ledger reserves
  `Backend::LocalJev` with the ordering "GYST cache → Laya → Jev"; the
  class layer's routing receipts already name their backend and state
  confidence as the probability of the chosen answer (the local tier's
  rule). The judge *engine* (Laya, Apache-2.0) is a build decision,
  not a source wait.
- [x] **C4 — build receipts.** The per-bundle sha256 build receipt is
  adopted as release practice; the plugin ships with one.
- [x] **C5 — skill-pack format.** Versioned markdown packs are the
  plugin's native shape. Known defect to fix in the plugin's own packs:
  two Jevie packs ship byte-identical runtime trees (~33 MB duplicated).
- [x] **C6 — tailnet transport note.** Corroboration recorded; the
  delta worth carrying is per-artifact tailnet identity.
- [x] **C8 — release practice.** The self-documenting bundle shape
  (281 design docs) is the documentation standard the plugin follows.
- [x] **Class layer running.** The semantics the plugin wraps — typed
  Identity, committed ceilings, refusal receipts, the hash-linked
  chain, `decision@1` routing receipts — run today in this repo's
  `class-layer/` against the estate board (see MAP.md). The plugin is
  a transfer of working semantics, not a design request.

## Patterns only — implementation waits for source

- [ ] **C3 — AX-grounded executor.** The pattern is mapped; the
  implementation (planner wiring, the executor itself) lives in the
  kernel, which ships as V8 bytecode (`kernel.jsc`).
- [ ] **C7 — on-device voice.** The panel voice tier is a pattern; the
  voice-pipeline wiring is in the kernel bytecode.

## The wait-list — exact items (fold-in §6)

1. [ ] **Kernel JS source.** Executor, planner wiring, voice wiring,
   the judge-warming daemon.
2. [ ] **`src/client.mjs`.** The canonical System One client; needed to
   prove the Python mirror (and the plugin's contract) has not drifted
   from the client the app runs.
3. [ ] **Swift shell + 9 helpers source.** Menu-bar shell, the AX
   bridge (the native half of the C3 contract), Capture/Session/Listen.
4. [ ] **JevieTailnet Go source.** Transport proven; the team
   call/presence protocol above it is not in the strings.
5. [ ] **JevieFind (fff) Rust source.** Crate-or-pattern depends on
   source and license posture in the repo.
6. [ ] **The build system.** build-info.json generation, where
   `skills.version` is stamped, the Sparkle/appcast pipeline.
7. [ ] **Laya checkpoint loading.** Checkpoints are not in the DMG;
   provenance is verified at the repo or the package.
8. [ ] **Server side.** The TypeSafe API and the jevie-cloud /
   jevie-downloads workers — out of scope unless the handoff includes
   them.

## State

Plugin semantics: RUNNING (class layer, this repo). Plugin package
against the founder's line: not yet assembled. Final target: gated on
Vlad's repo handoff — expected within days, after the holiday, and
de-pressured by the founder's own message to Vlad. Nothing on this
checklist is blocked on anything but the handoff itself.
