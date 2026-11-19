# ITPM lane — open decisions, as board records

Recorded 2026-11-19 from Lane C's completion report (Spoken ITPM
unblocking). Both decisions are the founder's; neither has been ruled.
State: the work behind both is done and verified; only the calls remain.

## Decision 1 — the git route for the deploy package

The deploy package is built and verified: `~/workspace/spoken-itpm/
deploy-package/`. Local HEAD (3db373f5) is the merge-base — 6 behind,
0 ahead of origin/main (7e0d8617). All 337 remote-main files are
byte-exact in the package; exactly 4 files are added, 0 modified,
0 deleted (the permits page, the plans page, 2 JSON snapshots). Build
rc=0. Nothing has been pushed or merged; `/permits` is still 404 on the
live surface.

The routes:

- **A — fast-forward + one commit on main + push.** Recommended by
  Prime: the package is purely additive over a merge-base HEAD, so the
  fast-forward is exact.
- **B — branch + PR.** The same content through a review gate.
- **C — hold.** The package stays local.

## Decision 2 — namespace #33 (the ITPM identity namespace)

All ITPM identities are PROVISIONAL uuid5 placeholders; the namespace
name is the open choice:

- **Prime's recommendation: uuid5(DNS, "itpm.somacosf.com")** — the
  product's own domain as the namespace root.
- The crews' alternative: "spoken-itpm.somacosf.com".

## Also landed in Lane C (no decision needed)

- **rustgis-permit is folded in.** The crate is now `pub mod permit` of
  the `rustgis-itpm` member crate of the imbue workspace
  (`~/workspace/imbue`); src/permit.rs is byte-identical to the
  standalone crate (sha1 c37d2d06…); `cargo test -p rustgis-itpm`
  passes 15/15 on the final bytes; the CLI was exercised on the live
  firehose. Records/index/geohex/query/export are not yet ported — the
  Python prototype (19/19) remains the spec for those.
