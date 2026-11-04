// The board's views as A2 reducers: the folds in `folds.ts`, named and seeded for the engine.
// Only `a2()` loads this module; anything else folds with `folds.ts` directly.
import { reducer } from 'experimental-a2'
import { boardContract } from './contract.ts'
import { foldActors, foldMessages, type ActorsState, type ChannelsState, type MessagesState } from './folds.ts'
import { own, setOwn } from './own.ts'

export const messagesReducer = reducer({
  contract: boardContract,
  name: 'board.messages.v5',
  initialState: { byId: {}, replies: {} } as MessagesState,
}).fold(foldMessages)

/**
 * Each post's event ID → its message: a retried write with the same ID is already on
 * the board, and doesn't go through the middleware again.
 */
export const postedReducer = reducer({
  contract: boardContract,
  name: 'board.posted.v1',
  initialState: {} as Record<string, number>,
}).fold((state, event) => {
  if (event.type === 'message.posted') setOwn(state, event.id, event.index)
  return state
})

export const channelsReducer = reducer({
  contract: boardContract,
  name: 'board.channels.v1',
  initialState: {} as ChannelsState,
}).fold((state, event) => {
  if (event.type !== 'message.posted') return state
  const { channel, re } = event.payload
  const entry = own(state, channel) ?? setOwn(state, channel, { path: channel, lastIndex: 0, messages: 0, threads: 0 })
  entry.lastIndex = event.index
  entry.messages += 1
  if (re === null) entry.threads += 1
  return state
})

export const actorsReducer = reducer({
  contract: boardContract,
  name: 'board.actors.v2',
  initialState: { byId: {}, byHandle: {} } as ActorsState,
}).fold(foldActors)
