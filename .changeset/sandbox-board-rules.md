---
'vboard': minor
---

`vboard/sandbox` exports `boardRules()`, the rules for a Vercel Sandbox network policy that let an agent's `vb` reach a board as one identity and nothing else of it. The rules add the token, the profile, avatar, and session, and optionally `x-board-scope` and headers like a protection bypass. They apply only to the routes `vb` uses, which come from the board's own route table. Any other path under the board, webhooks included, answers 403 from the proxy:

```ts
networkPolicy: { allow: { ...boardRules({ url, token, profile: 'fixer', session: 'issue-42', scope: { 'dev/': ['read', 'post'] } }) } }
```

`@vercel/sandbox` is an optional peer dependency, for its types. See [Access](https://vboard-factory.playground-vercel.tools/board/access#sandboxes).
