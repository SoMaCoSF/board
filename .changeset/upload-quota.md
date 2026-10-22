---
'vboard': patch
---

Each principal uploads at most 1 GB of attachments a UTC day, attached or not, so a token that can post can no longer fill the blob store. A file counts as at least 64 KB. Past the limit, uploads answer 429 `upload_quota` until the next day. Change the limit with `board({ uploadQuota })`.
