"use client";

import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { board, type Attachment, type MessageView } from "@vercel/board";
import { http } from "@vercel/board/backend-http";
import { ArrowUp, FileText, Loader, Paperclip, SmilePlus, X } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// The launcher's chat: a board handle in the page, on `http()` to the launcher's proxy, which acts as
// `launcher` in one channel. Everything here is the handle's API: messages, events, post, reply,
// react, upload, and download.

type Board = ReturnType<typeof board>;

/** A newer view of a message replaces an older one, and never the other way round. */
function merge(known: Map<string, MessageView>, views: MessageView[]) {
  let next: Map<string, MessageView> | null = null;
  for (const view of views) {
    const had = (next ?? known).get(view.id);
    if (had && had.version >= view.version) continue;
    next ??= new Map(known);
    next.set(view.id, view);
  }
  return next ?? known;
}

const byTime = (a: MessageView, b: MessageView) => a.createdAt.localeCompare(b.createdAt);

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

// Messages are Markdown. Raw HTML in them stays text (react-markdown's default), and links open elsewhere.
const MARKDOWN: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/** Reactions are stored by short name. These show as themselves; any other shows as `:name:`. */
const EMOJI: Record<string, string> = { thumbs_up: "👍", eyes: "👀", party: "🎉", check: "✅", heart: "❤️", rocket: "🚀", fire: "🔥", pray: "🙏" };
const PICK = ["thumbs_up", "eyes", "party", "heart", "check"];

/** What the board takes in one request; bigger files go to its blob store, which this chat doesn't do. */
const FILE_BYTES_MAX = 4 * 1024 * 1024;

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

type Context = { team: Board | null; me: string | null; react: (id: string, emoji: string, remove: boolean) => void };

/** The reactions on a message, each a toggle for yours, and while `picking`, a few to add. */
function Reactions({ message, context, picking, done }: { message: MessageView; context: Context; picking: boolean; done: () => void }): ReactNode {
  const given = Object.entries(message.reactions).filter(([, who]) => who.length > 0);
  if (given.length === 0 && !picking) return null;
  return (
    <div className="chat-reactions">
      {given.map(([emoji, who]) => {
        const mine = context.me !== null && who.includes(context.me);
        return (
          <button key={emoji} type="button" className="chat-reaction" data-mine={mine ? "" : undefined} onClick={() => context.react(message.id, emoji, mine)}>
            {EMOJI[emoji] ?? `:${emoji}:`} {who.length}
          </button>
        );
      })}
      {picking
        ? PICK.filter((emoji) => !given.some(([name]) => name === emoji)).map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="chat-reaction"
              data-pick=""
              onClick={() => {
                context.react(message.id, emoji, false);
                done();
              }}
            >
              {EMOJI[emoji]}
            </button>
          ))
        : null}
    </div>
  );
}

/** A file on a message: images and videos inline, from a `blob:` URL the page fetches through the proxy; anything else as a chip that saves it. */
function FileView({ file, team }: { file: Attachment; team: Board | null }): ReactNode {
  const media = /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) ? "image" : /^video\/(mp4|webm)$/.test(file.type) ? "video" : null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!media || !team) return;
    let live = true;
    let made: string | null = null;
    team
      .download(file.id)
      .then(async (response) => {
        if (!response.ok) return;
        made = URL.createObjectURL(await response.blob());
        if (live) setUrl(made);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file.id, media, team]);
  async function save() {
    if (!team) return;
    const response = await team.download(file.id);
    if (!response.ok) return;
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await response.blob()), download: file.name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }
  const title = `${file.name} · ${size(file.size)}`;
  if (media === "image") return <a className="chat-media" href={url ?? undefined} target="_blank" rel="noreferrer" title={title}>{url ? <img src={url} alt={file.name} /> : null}</a>;
  if (media === "video") return <span className="chat-media" title={title}>{url ? <video src={url} controls preload="metadata" /> : null}</span>;
  return (
    <button type="button" className="chat-file" title={`Save ${file.name}`} onClick={() => void save()}>
      <FileText size={12} aria-hidden /> {file.name} <span>{size(file.size)}</span>
    </button>
  );
}

function Message({ message, agent, now, context }: { message: MessageView; agent: string; now: number; context: Context }): ReactNode {
  const [picking, setPicking] = useState(false);
  return (
    <div className="chat-message" data-agent={message.by.profile === agent ? "" : undefined}>
      <div className="chat-meta">
        <span className="chat-author">{message.author?.name ?? message.by.profile ?? message.by.actor}</span>
        <time dateTime={message.createdAt}>{ago(message.createdAt, now)}</time>
        <button type="button" className="chat-react" aria-label="React" aria-pressed={picking} onClick={() => setPicking((open) => !open)}>
          <SmilePlus size={13} aria-hidden />
        </button>
      </div>
      <div className="chat-text">
        <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
          {message.text}
        </Markdown>
      </div>
      {message.attachments.length ? (
        <div className="chat-files">
          {message.attachments.map((file) => (
            <FileView key={file.id} file={file} team={context.team} />
          ))}
        </div>
      ) : null}
      <Reactions message={message} context={context} picking={picking} done={() => setPicking(false)} />
    </div>
  );
}

export function Chat({ channel, agent }: { channel: string; agent: string }): ReactNode {
  const [team, setTeam] = useState<Board | null>(null);
  const [messages, setMessages] = useState(() => new Map<string, MessageView>());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const handle = board({
      backend: http(`${location.origin}/api/launcher/board`, { fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }) }),
    });
    setTeam(handle);
    handle.me().then((who) => setMe(who.actor), () => {});
    const controller = new AbortController();
    (async () => {
      // Follow first, then read: a message that lands in between comes in both, and merging keeps one.
      const live = handle.events({ channel }, { signal: controller.signal });
      const first = live.next();
      const { messages: page } = await handle.messages({ channel, limit: 200 });
      setMessages((known) => merge(known, page));
      setLoaded(true);
      for (let next = await first; !next.done; next = await live.next()) {
        const view = next.value.message;
        if (view) setMessages((known) => merge(known, [view]));
      }
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      controller.abort();
      clearInterval(clock);
    };
  }, [channel]);

  const threads = useMemo(() => {
    const live = [...messages.values()].filter((message) => !message.deleted);
    return live
      .filter((message) => message.re === null)
      .sort(byTime)
      .map((root) => ({ root, replies: live.filter((message) => message.re === root.id).sort(byTime) }));
  }, [messages]);

  // New messages scroll into view only for a reader already at the bottom: nothing moves what you're reading.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [threads]);

  function attach(picked: Iterable<File>) {
    const all = [...picked];
    const big = all.find((file) => file.size > FILE_BYTES_MAX);
    if (big) setError(`${big.name} is ${size(big.size)}: the chat takes files of at most 4 MB.`);
    setFiles((known) => [...known, ...all.filter((file) => file.size <= FILE_BYTES_MAX)]);
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && files.length === 0) || !team || sending) return;
    setSending(true);
    setError(null);
    try {
      const attachments = await Promise.all(files.map((file) => team.upload({ data: file, name: file.name })));
      const input = { text, ...(attachments.length ? { attachments } : {}) };
      const sent = target ? await team.reply(target, input) : await team.post(channel, input);
      setMessages((known) => merge(known, [sent]));
      setTarget(sent.re ?? sent.id);
      setDraft("");
      setFiles([]);
      pinned.current = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  const context: Context = {
    team,
    me,
    react: (id, emoji, remove) => {
      if (!team) return;
      // The new view comes back on the events stream, like anyone else's reaction.
      team.react(id, emoji, { remove }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    },
  };

  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) void send(event);
  }

  return (
    <section className="chat" aria-label={`#${channel}`}>
      <div className="chat-head">
        <span>#{channel}</span>
      </div>
      <div
        className="chat-log"
        ref={log}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!loaded ? (
          <p className="chat-empty">{error ? "" : "Loading"}</p>
        ) : threads.length === 0 ? (
          <p className="chat-empty">Nothing here yet. Ask it anything about itself.</p>
        ) : (
          threads.map(({ root, replies }) => {
            return (
              <article key={root.id} className="chat-thread" data-target={target === root.id ? "" : undefined}>
                <Message message={root} agent={agent} now={now} context={context} />
                {replies.length ? (
                  <div className="chat-replies">
                    {replies.map((reply) => (
                      <Message key={reply.id} message={reply} agent={agent} now={now} context={context} />
                    ))}
                  </div>
                ) : null}
                <div className="chat-foot">
                  {target === root.id ? null : (
                    <button type="button" className="chat-reply" onClick={() => setTarget(root.id)}>
                      reply
                    </button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
      <form
        className="composer"
        onSubmit={send}
        onDragOver={(event: DragEvent) => event.preventDefault()}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          attach(event.dataTransfer.files);
        }}
      >
        {target ? (
          <div className="composer-target">
            <span>in #{target}</span>
            <button type="button" aria-label="Start a new thread" onClick={() => setTarget(null)}>
              <X size={12} aria-hidden />
            </button>
          </div>
        ) : null}
        {files.length ? (
          <div className="composer-files">
            {files.map((file, i) => (
              <span key={`${file.name}-${i}`} className="chat-file">
                <FileText size={12} aria-hidden /> {file.name} <span>{size(file.size)}</span>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((known) => known.filter((_, j) => j !== i))}>
                  <X size={12} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) attach(event.target.files);
              event.target.value = "";
            }}
          />
          <button type="button" className="attach" aria-label="Attach files" onClick={() => picker.current?.click()}>
            <Paperclip size={14} aria-hidden />
          </button>
          <textarea
            onPaste={(event: ClipboardEvent) => {
              if (event.clipboardData.files.length) {
                event.preventDefault();
                attach(event.clipboardData.files);
              }
            }}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keys}
            placeholder={target ? `Reply to ${agent}` : `Ask ${agent} anything`}
            rows={1}
            aria-label="Message"
          />
          <button type="submit" className="send" disabled={(!draft.trim() && files.length === 0) || sending || !team} aria-label="Send">
            {sending ? <Loader size={14} aria-hidden className="spin" /> : <ArrowUp size={14} aria-hidden />}
          </button>
        </div>
      </form>
      {error ? <p className="chat-error">{error}</p> : null}
    </section>
  );
}
