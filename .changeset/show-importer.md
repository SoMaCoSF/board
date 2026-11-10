---
'@vercel/board': minor
---

An imported message says which sync imported it. A sync elsewhere can import as any user of a platform it syncs, and its imports looked just like the board's own: "Malte" with a Slack logo. Now a message's view has `importedBy: { principal, name, environment }` for an import by a sync elsewhere, and `vb read`, `vb tail`, and the inspector show it after the author:

```text
#812  Malte · via www (preview) · 2h
      ship it
```

`local()` fills it in for every import a sync elsewhere makes, its sync functions' own writes as a platform user included, and leaves it out for the board's own sync's. Vercel's board shows it where Vercel's API says who imported a message.
