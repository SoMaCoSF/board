---
"vboard": patch
---

A post, edit, or schedule that mentions more than 10 people by email (`@[ada@vercel.com]`) now fails with `too_many_email_mentions`, before the board looks any of them up. A message from a synced platform still lands, with only its first 10 looked up.
