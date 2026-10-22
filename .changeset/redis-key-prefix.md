---
'vboard': patch
---

The Redis stores' `keyPrefix` is documented as what it is: where the board's keys go, not access control. Anything with the URL or token reaches every key, so the database docs now say to keep production's database out of previews.
