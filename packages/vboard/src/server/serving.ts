// What a board needs to serve requests, loaded the first time it serves one: token verification,
// and the board's own Vercel project, from the environment and `.vercel/project.json`. And a
// watcher's `once`, whose write IDs follow Node's AsyncLocalStorage.
export { createVerifier, hostPrincipal } from './auth.ts'
export { discoveryIdentity, ownProjectId, ownTeamId } from './identity.ts'
export { createOnce, nextWriteId } from './once.ts'
