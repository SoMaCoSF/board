---
'@vercel/board': minor
---

On Vercel's board, `vb grants create` and `update` with `--github` or `--oidc`, and `vb tokens create` run as a person, say why Vercel's API refuses them and what to do instead, with reason `unsupported_principal`. Vercel's API takes no GitHub or OIDC principal in a grant: a workflow gets in as a Vercel App, which an OIDC exchange policy issues its token for, and the grant names that app. It mints board tokens only for a deployment, or from a board token. `grants create` no longer notes that Vercel's board doesn't sign in GitHub or OIDC callers yet (`callers_not_signed_in`), since it takes no such grant. The conformance kit skips its grants checks that name a repository on `unsupported_principal`, and its tokens checks where the run mints none.

```text
$ vb grants create --github acme/web --can 'ci/=post' --scope acme
error: Vercel's board takes no GitHub or OIDC principals in a grant.

  Grant an app that an OIDC exchange policy issues tokens for: --app <slug>.
```
