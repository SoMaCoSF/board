// `vboard/access`: who may use a board, and what each may do in which channels. Backend-agnostic:
// the rules board() takes, `oidcTokens()` (its verifier by default), and the pieces it decides with.
export {
  vercelProject,
  githubActions,
  oidc,
  type AccessRule,
  type AccessFunction,
  type RuleFunction,
  type Authenticate,
  type AuthenticateContext,
  type HostPrincipal,
  type Known,
  type Principal,
  type PrincipalKind,
  type OidcTokensOptions,
  type IssuerConfig,
  type CallerRequest,
  type Claims,
} from '../server/auth.ts'
export { oidcTokens } from '../server/tokens.ts'
export { resolveActor } from '../server/actors.ts'
export { compileRules } from '../server/auth.ts'
export { type Access, type Permission, type ChannelPattern, type Grant, type Can, type AccessSummary } from '../server/access.ts'
