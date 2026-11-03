"use client";

import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { board, type MessageView } from "@vercel/board";
import { http } from "@vercel/board/backend-http";
import { ArrowUp, Loader, X } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// The launcher's chat: a board handle in the page, on `http()` to the launcher's proxy, which acts as
// `launcher` in one channel. Everything here is the handle's API: messages, events, post, reply.

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

function Message({ message, agent, now }: { message: MessageView; agent: string; now: number }): ReactNode {
  return (
    <div className="chat-message" data-agent={message.by.profile === agent ? "" : undefined}>
      <div className="chat-meta">
        <span className="chat-author">{message.author?.name ?? message.by.profile ?? message.by.actor}</span>
        <time dateTime={message.createdAt}>{ago(message.createdAt, now)}</time>
      </div>
      <div className="chat-text">
        <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
          {message.text}
        </Markdown>
      </div>
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
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const handle = board({
      backend: http(`${location.origin}/api/launcher/board`, { fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }) }),
    });
    setTeam(handle);
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

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !team || sending) return;
    setSending(true);
    setError(null);
    try {
      const sent = target ? await team.reply(target, text) : await team.post(channel, text);
      setMessages((known) => merge(known, [sent]));
      setTarget(sent.re ?? sent.id);
      setDraft("");
      pinned.current = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

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
            const last = replies.at(-1) ?? root;
            const waiting = last.by.profile !== agent && now - Date.parse(last.createdAt) < 10 * 60_000;
            return (
              <article key={root.id} className="chat-thread" data-target={target === root.id ? "" : undefined}>
                <Message message={root} agent={agent} now={now} />
                {replies.length ? (
                  <div className="chat-replies">
                    {replies.map((reply) => (
                      <Message key={reply.id} message={reply} agent={agent} now={now} />
                    ))}
                  </div>
                ) : null}
                <div className="chat-foot">
                  {waiting ? (
                    <span className="chat-waiting">
                      <Loader size={12} aria-hidden className="spin" /> {agent} is on it
                    </span>
                  ) : null}
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
      <form className="composer" onSubmit={send}>
        {target ? (
          <div className="composer-target">
            <span>in #{target}</span>
            <button type="button" aria-label="Start a new thread" onClick={() => setTarget(null)}>
              <X size={12} aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="composer-row">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keys}
            placeholder={target ? `Reply to ${agent}` : `Ask ${agent} anything`}
            rows={1}
            aria-label="Message"
          />
          <button type="submit" className="send" disabled={!draft.trim() || sending || !team} aria-label="Send">
            {sending ? <Loader size={14} aria-hidden className="spin" /> : <ArrowUp size={14} aria-hidden />}
          </button>
        </div>
      </form>
      {error ? <p className="chat-error">{error}</p> : null}
    </section>
  );
}
