import { createHash } from 'node:crypto'
import { reducer, type ContractEvent } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Store } from 'experimental-a2/server'
import type { RegistrationView } from '../api/routes.ts'
import { REGISTRY_SESSION, registryContract, type RegistryEvents } from '../contract/contract.ts'

export type WatcherSpec = { tail: string; when: 'matches' | 'enters' }

export type Registration = RegistrationView

export type RegistryState = { byOwner: Record<string, Registration> }

/** The same on both ends: a board with a remote hashes its watchers, and its remote the ones it holds. */
export function watchersHash(watch: Record<string, WatcherSpec>): string {
  const canonical = Object.keys(watch)
    .sort()
    .map((id) => [id, watch[id]!.tail, watch[id]!.when])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)
}

function foldRegistry(state: RegistryState, event: ContractEvent<RegistryEvents>): RegistryState {
  if (event.type === 'watchers.registered') {
    const { owner, url, watch, hash } = event.payload
    const copied = Object.fromEntries(Object.entries(watch).map(([id, spec]) => [id, { tail: spec.tail, when: spec.when }]))
    state.byOwner[owner] = { owner, url, watch: copied, hash }
  }
  return state
}

export const registryReducer = reducer({
  contract: registryContract,
  name: 'vboard.registry.v1',
  initialState: { byOwner: {} } as RegistryState,
}).fold(foldRegistry)

/** Watchers registered with this board by boards that have it as their remote. */
export function createRegistry(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined }) {
  const server = createServer({
    contract: registryContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })
  const session = server.session(REGISTRY_SESSION)
  const state = async () => (await session.state(registryReducer)).state

  return {
    server,
    state,
    /** Replaces `owner`'s registration. One that changes nothing writes nothing, so asking again is free. */
    async register(owner: string, input: { url: string; watch: Record<string, WatcherSpec> }): Promise<Registration> {
      const hash = watchersHash(input.watch)
      const current = (await state()).byOwner[owner]
      if (current && current.url === input.url && current.hash === hash) return current
      await session.append({ type: 'watchers.registered', payload: { owner, url: input.url, watch: input.watch, hash } })
      return { owner, url: input.url, watch: input.watch, hash }
    },
    async list(): Promise<Registration[]> {
      return Object.values((await state()).byOwner).sort((a, b) => a.owner.localeCompare(b.owner))
    },
  }
}
