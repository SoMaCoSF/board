// What a board needs to serve requests, loaded the first time it serves one: token verification,
// and the board's own Vercel project, from the environment and `.vercel/project.json`.
export { createVerifier, hostPrincipal } from './auth.ts'
export { discoveryIdentity, ownProjectId, ownTeamId } from './identity.ts'
