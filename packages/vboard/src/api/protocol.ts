import type { z } from 'zod'
import type { Actor } from '../contract/reducers.ts'
import type { Attachment } from '../contract/schemas.ts'
import type {
  AckBody,
  ChannelView,
  EditBody,
  EventsPage,
  EventsQuery,
  IdentityView,
  InboxAckBody,
  InboxEntry,
  InboxItem,
  InboxNextQuery,
  InboxPushBody,
  InboxQuery,
  LinkedAccount,
  LabelBody,
  MatchesQuery,
  MatchView,
  Me,
  MessagesPage,
  MessagesQuery,
  MessageView,
  OnceBody,
  OnceQuery,
  OnceView,
  PersonView,
  PostBody,
  ReactBody,
  RegisterBody,
  RegistrationView,
  ScheduleBody,
  SchedulesQuery,
  ScheduleView,
  ThreadsPage,
  SyncAccountBody,
  SyncCodeBody,
  SyncCopiesQuery,
  SyncCopiesView,
  SyncFindQuery,
  SyncFindView,
  SyncImportBody,
  SyncReceiptBody,
  SyncRootsQuery,
  SyncThreadView,
  SyncUnlinkBody,
  ThreadsQuery,
  ThreadView,
} from './routes.ts'

type Input<S extends z.ZodType> = NonNullable<z.output<S>>
type Id = { id: string }
type Key = { key: string }
type Nothing = Record<string, never>

/**
 * The protocol, method by method: what each takes and what it answers, as the wire carries them.
 * board() serves each at its route in `routes` and calls the backend's method of the same name.
 */
export type Protocol = {
  me: { input: Nothing; output: Me }
  channels: { input: Nothing; output: { channels: ChannelView[]; cursor: string } }
  actors: { input: Nothing; output: { actors: (Actor & { person?: PersonView })[]; cursor: string } }
  identity: { input: Nothing; output: IdentityView }
  messages: { input: Input<typeof MessagesQuery>; output: MessagesPage }
  threads: { input: Input<typeof ThreadsQuery>; output: ThreadsPage }
  message: { input: Id; output: ThreadView }
  post: { input: Input<typeof PostBody>; output: { message: MessageView; unknownMentions?: string[] } }
  /** The caller's own post with client ID `id`, as it landed: 404 `post_not_found` when there's none. */
  posted: { input: Id; output: { message: MessageView } }
  edit: { input: Id & Input<typeof EditBody>; output: { ok: true; unknownMentions?: string[] } }
  delete: { input: Id; output: { ok: true } }
  react: { input: Id & Input<typeof ReactBody>; output: { ok: true } }
  label: { input: Id & Input<typeof LabelBody>; output: { ok: true } }
  schedule: { input: Input<typeof ScheduleBody>; output: { schedule: ScheduleView; unknownMentions?: string[] } }
  schedules: { input: Input<typeof SchedulesQuery>; output: { schedules: ScheduleView[] } }
  cancelSchedule: { input: Id; output: { schedule: ScheduleView; canceled: boolean } }
  upload: { input: { data: Uint8Array; name: string | null; type: string | null }; output: { attachment: Attachment } }
  attachment: { input: Id; output: { attachment: Attachment; data: Uint8Array | ReadableStream<Uint8Array> } }
  watchers: { input: Nothing; output: { watchers: RegistrationView[] } }
  register: { input: Input<typeof RegisterBody>; output: RegistrationView }
  matches: { input: Input<typeof MatchesQuery>; output: { matches: MatchView[] } }
  ack: { input: Id & Input<typeof AckBody>; output: { ok: true } }
  /** The calling watcher's once record for `key`, or null: its own, as the actor it writes as. */
  once: { input: Input<typeof OnceQuery>; output: { once: OnceView | null } }
  /** Records unless a record stands, and answers the one that stands: maybe another run's. */
  recordOnce: { input: Input<typeof OnceBody>; output: { once: OnceView } }
  /** Long-polls with `wait`. board() serves SSE from it, so a backend has one way to read events. */
  events: { input: Input<typeof EventsQuery>; output: EventsPage }

  // Sync's records, which sync in board() keeps through these wherever the board lives. Each needs `sync`.
  /** A platform's write as its platform author, idempotent per platform event. */
  syncImport: { input: Input<typeof SyncImportBody>; output: { message: string | null } }
  /** A delivery, its files, a failure, or a thread's new target. `attached` is false for a target the thread had. */
  syncReceipt: { input: Input<typeof SyncReceiptBody>; output: { ok: true; attached?: boolean } }
  syncThread: { input: { thread: string }; output: SyncThreadView }
  syncFind: { input: Input<typeof SyncFindQuery>; output: SyncFindView }
  syncCopies: { input: Input<typeof SyncCopiesQuery>; output: SyncCopiesView }
  syncRoots: { input: Input<typeof SyncRootsQuery>; output: { roots: MessageView[] } }
  /** Platform events into the caller's inbox, deduplicated by their platform IDs. */
  inboxPush: { input: Key & Input<typeof InboxPushBody>; output: { ok: true } }
  /** The caller's next inbox events, leased, one platform thread at a time and in order. */
  inboxNext: { input: Key & Input<typeof InboxNextQuery>; output: { items: InboxItem[] } }
  inboxAck: { input: Key & Id & Input<typeof InboxAckBody>; output: { ok: true } }
  /** Raw platform events, newest first, for debugging sync. */
  inbox: { input: Key & Input<typeof InboxQuery>; output: { events: InboxEntry[] } }
  syncCode: { input: Input<typeof SyncCodeBody>; output: { code: string; expiresAt: string } }
  /** 404 `bad_code` for a code that isn't live. */
  syncAccount: { input: Input<typeof SyncAccountBody>; output: { person: string; link: LinkedAccount } }
  syncUnlink: { input: Input<typeof SyncUnlinkBody>; output: { ok: true } }
}

export type Method = keyof Protocol
