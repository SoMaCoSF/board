# The map — board event → task Identity → receipt → sink

Identity Is Infrastructure

Generated 11/19/2026, 15:24 PT from the live data directory (/home/hatch/workspace/board-estate), read at
generation time: the Identity registry, the receipt chain, the escrow file,
and the board's own task list through the `@vercel/board` handle. Every
number below comes from that state.

All Identities on this board are PROVISIONAL — uuid5 placeholders derived
per `class-layer/src/uuid.ts`, pending the founder's mint rulings.
Sink state: local-only — SUPABASE_URL / SUPABASE_SECRET_KEY not set in the environment; no Supabase writes made.

## Identities

| name | type | uuid | ceiling | commitment |
| --- | --- | --- | --- | --- |
| witness | actor | f4a70971-09f8-5105-b4e9-ede42e53b456 | CLAIM, CLASSIFY, COMPLETE, ESCROW, EXECUTE, MANAGE, READ, ROUTE, SEND, WRITE | 4d8f0108aade |
| worker-docs | actor | 5becb3cd-0439-5eae-9f6f-006489f2d54d | CLAIM, CLASSIFY, COMPLETE, READ, WRITE | dd17ffcbf8b6 |
| worker-build | actor | 66bdd41e-5d04-5acc-ba8f-f67433adc1f9 | CLAIM, COMPLETE, EXECUTE, READ, WRITE | 202ea0093cc2 |
| mail-sort-pack | actor | 82540b0b-3a13-5011-a6d4-40f37db4967a | CLASSIFY, READ | d6bea5e13f5e |
| task:estate:7 | task | 37df8367-4d97-5193-a6ec-f338e4c5fa36 | — | 1b227a7d072d |
| task:estate:9 | task | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | — | 4f6d0dafd0b4 |
| task:estate:11 | task | 2b986600-ec2f-5574-97d0-dcd228495634 | — | e7de2f45db7b |
| task:estate:13 | task | 5d2fe734-baca-5c31-b13e-b7d8f14af6f2 | — | 5601ce52dd4e |
| task:estate:15 | task | b4f182f2-9e86-564e-b921-c10dc83a381e | — | 4b1b8c2e7269 |
| task:estate:17 | task | a94e6282-0fdc-5d44-a508-409c949cc600 | — | 5d94dc12e305 |

## Tasks on board `estate`

6 tasks (6 completed).

| board id | channel | title | state | claim holder (board actor id) | task uuid |
| --- | --- | --- | --- | --- | --- |
| 7 | board-build | Write the class-layer usage note for agent briefs | completed | — | 37df8367-4d97-5193-a6ec-f338e4c5fa36 |
| 9 | board-build | Verify the receipt chain and publish the verification result | completed | — | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 |
| 11 | polaris | Draft the upstream issue text for the IMBUUID class - issue-first, dra | completed | — | 2b986600-ec2f-5574-97d0-dcd228495634 |
| 13 | jevie | Compile the Jevie plugin readiness checklist from the fold-in wait-lis | completed | — | 5d2fe734-baca-5c31-b13e-b7d8f14af6f2 |
| 15 | itpm | Record the ITPM lane open decisions as a board document | completed | — | b4f182f2-9e86-564e-b921-c10dc83a381e |
| 17 | status | Confirm the board-mission-control lane carries the class-layer build | completed | — | a94e6282-0fdc-5d44-a508-409c949cc600 |

## The trace

One row per receipt: the board event it mirrors (by board cursor, when the
receipt came from the board sync) or the class-layer act itself, the task
Identity it concerns, and where the receipt is stored.

| # | action | actor | task uuid | receipt uuid | hash (prefix) | board cursor | sink |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | identity.registered | witness | — | 688ac338-e342-5505-9a00-b1a0e3e20ce1 | ea90a4ba038f | — | local chain #0 |
| 1 | identity.registered | worker-docs | — | a8f3150a-06e4-5c9c-8475-ee4d5ed0c310 | 1824160509f1 | — | local chain #1 |
| 2 | identity.registered | worker-build | — | c6796f19-484a-5e45-90b2-29ce49914fe8 | 8c5f59af62d3 | — | local chain #2 |
| 3 | identity.registered | mail-sort-pack | — | e437219c-643e-5e60-9f3b-3c3f0b7d222f | 40335df417b7 | — | local chain #3 |
| 4 | task.posted | witness | 37df8367-4d97-5193-a6ec-f338e4c5fa36 | f6697dfa-6c4c-5aed-b3f8-7b4ad6648b84 | 98a23e545ded | 8 | local chain #4 |
| 5 | task.posted | witness | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | 0c1716ed-6ebb-54e6-9d86-161459997e9b | 62e46e197f5d | 10 | local chain #5 |
| 6 | task.posted | witness | 2b986600-ec2f-5574-97d0-dcd228495634 | aac5af15-4ed3-54b5-a4c3-07fc290376eb | 0608cfe8001b | 12 | local chain #6 |
| 7 | task.posted | witness | 5d2fe734-baca-5c31-b13e-b7d8f14af6f2 | e36e5e7b-4e36-5806-aeb1-fc92c8d4b765 | 43e4b1939779 | 14 | local chain #7 |
| 8 | task.posted | witness | b4f182f2-9e86-564e-b921-c10dc83a381e | 63d41ceb-9884-59a6-86f0-0b729ac2e247 | ed5a2d4c9024 | 16 | local chain #8 |
| 9 | task.posted | witness | a94e6282-0fdc-5d44-a508-409c949cc600 | 9c220da2-73dd-5de5-b1fe-323c16ecac78 | 36f5e61f8efa | 18 | local chain #9 |
| 10 | decision.routed | witness | 37df8367-4d97-5193-a6ec-f338e4c5fa36 | c90e1d05-5e04-5d63-aa0e-d983d3034422 | 85677b8f3688 | — | local chain #10 |
| 11 | decision.routed | witness | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | 710f4f60-1ee4-5228-b67a-df762a83795c | 52e87cce73fd | — | local chain #11 |
| 12 | decision.routed | witness | 2b986600-ec2f-5574-97d0-dcd228495634 | 07cde159-26a3-55c0-8a38-358a5c10798d | eaf0db4a982e | — | local chain #12 |
| 13 | decision.routed | witness | 5d2fe734-baca-5c31-b13e-b7d8f14af6f2 | 9e44ea2b-1432-5000-aee3-a8225a74c47e | 3685897fc1b6 | — | local chain #13 |
| 14 | decision.routed | witness | b4f182f2-9e86-564e-b921-c10dc83a381e | fe92c4f1-a240-55c4-ace2-6641d048d7ce | 5b0d7ddf4f62 | — | local chain #14 |
| 15 | decision.routed | witness | a94e6282-0fdc-5d44-a508-409c949cc600 | 65beaf03-9bc6-5056-90e3-66cc00d99b64 | fd2485cff38a | — | local chain #15 |
| 16 | escrow.held | witness | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | 6f244f1c-2d67-56e8-bcee-f88cb3012a2c | 6fcedfa17fe2 | — | local chain #16 |
| 17 | task.claimed | worker-docs | 37df8367-4d97-5193-a6ec-f338e4c5fa36 | 3b458330-58c7-5270-b65a-a1cb6432c5a8 | 76b34738d5a8 | 20 | local chain #17 |
| 18 | task.claimed | worker-docs | 2b986600-ec2f-5574-97d0-dcd228495634 | 9706b45b-919d-5c5c-969f-316c372a1de2 | e95aca579c14 | 21 | local chain #18 |
| 19 | task.claimed | worker-docs | 5d2fe734-baca-5c31-b13e-b7d8f14af6f2 | 291bb44b-d00b-5ece-9322-cfc4cfff8709 | b99f69b6285a | 22 | local chain #19 |
| 20 | task.claimed | worker-docs | b4f182f2-9e86-564e-b921-c10dc83a381e | 4f0f4760-9ade-5a94-99af-4c340661bff8 | 1b472275bf16 | 23 | local chain #20 |
| 21 | task.claimed | worker-build | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | 3064d33a-6a60-503b-8f38-774e28f68144 | 6424db5da180 | 25 | local chain #21 |
| 22 | task.claimed | witness | a94e6282-0fdc-5d44-a508-409c949cc600 | 3cb289f3-329a-5673-befc-c56b1690f007 | 4891fb1df95b | 26 | local chain #22 |
| 23 | task.completed | worker-docs | 37df8367-4d97-5193-a6ec-f338e4c5fa36 | 0379df89-b488-5dc5-9a97-49863ca5667d | 549f2d19aabe | 27 | local chain #23 |
| 24 | task.completed | worker-docs | 2b986600-ec2f-5574-97d0-dcd228495634 | 1fe59d91-b0b7-5df2-baf0-c5f9b75055fd | 9e32ccff20c6 | 28 | local chain #24 |
| 25 | task.completed | worker-docs | 5d2fe734-baca-5c31-b13e-b7d8f14af6f2 | ab0a5149-a3cc-5b44-81ec-5987abc241fb | 38dc072e59ca | 29 | local chain #25 |
| 26 | task.completed | worker-docs | b4f182f2-9e86-564e-b921-c10dc83a381e | b194921d-47c8-52cc-a159-9f00da498fa0 | 5033059dedb1 | 30 | local chain #26 |
| 27 | step.read | mail-sort-pack | — | 92341c96-e4f4-578d-9d50-9ef42e42acc2 | 1d721e8e20c7 | — | local chain #27 |
| 28 | step.classify | mail-sort-pack | — | 88dc5c14-1e9a-5f47-9226-5f2b408fc794 | ae51fa6a8d32 | — | local chain #28 |
| 29 | ceiling.refused | mail-sort-pack | — | ba07341a-e106-5e9e-a90a-71047c20f2dc | 236172cde582 | — | local chain #29 |
| 30 | ceiling.refused | worker-build | — | f976f190-4229-5c5c-8911-98d1d09ea361 | 7390b5d2194b | — | local chain #30 |
| 31 | step.execute | worker-build | — | 9e7b9e59-5f0e-5a69-8321-bcc9f397c65f | 4ca33b097282 | — | local chain #31 |
| 32 | task.completed | worker-build | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | 36adea80-c9e8-503a-b960-b63bfb7545f9 | f1246592f3de | 31 | local chain #32 |
| 33 | escrow.released | worker-build | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | 7f9fabe3-b0c3-56cc-9e82-50bccdf0b284 | 7d3c41eb4f6b | — | local chain #33 |
| 34 | task.completed | witness | a94e6282-0fdc-5d44-a508-409c949cc600 | 19398e9d-6b9b-578c-9b80-cda402108408 | ad8e4c9be10b | 32 | local chain #34 |

## Escrow (test value)

| hold uuid | task uuid | amount | state | release receipt |
| --- | --- | --- | --- | --- |
| b7112c29-4b81-5664-aa00-9d5e34dc96fd | 4efc7427-7fa0-5d5b-a1a3-7e4e2d12d8d4 | 25 test | released | 7f9fabe3-b0c3-56cc-9e82-50bccdf0b284 |

## Chain

35 receipts. Verify: OK — every link recomputes; head ad8e4c9be10b.
