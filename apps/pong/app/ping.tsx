"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ping, thread, type Line } from "./actions";

/** How long a ping waits for its pong, and how often it looks. */
const WAIT_MS = 30_000;
const EVERY_MS = 1_000;

type Round = { ping: Line; replies: Line[]; ms: number | null; status: "waiting" | "ponged" | "timed out" | string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function Ping() {
  const [text, setText] = useState("hello");
  const [round, setRound] = useState<Round | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const started = performance.now();
    try {
      const sent = await ping(text, crypto.randomUUID());
      let current: Round = { ping: sent, replies: [], ms: null, status: "waiting" };
      setRound(current);
      while (performance.now() - started < WAIT_MS) {
        await sleep(EVERY_MS);
        const { replies } = await thread(sent.id);
        const pong = replies.find((reply) => reply.text.startsWith("pong from "));
        current = { ...current, replies, ...(pong ? { ms: Math.round(performance.now() - started), status: "ponged" } : {}) };
        setRound(current);
        if (pong) return;
      }
      setRound({ ...current, status: "timed out" });
    } catch (error) {
      setRound((last) => ({ ping: last?.ping ?? { id: "", text, author: "", createdAt: "" }, replies: last?.replies ?? [], ms: null, status: (error as Error).message }));
    } finally {
      setBusy(false);
      // The recent pings below, this one included.
      router.refresh();
    }
  }

  return (
    <section>
      <form onSubmit={send}>
        <input value={text} onChange={(event) => setText(event.target.value)} maxLength={500} aria-label="message" />
        <button type="submit" disabled={busy || !text.trim()}>
          {busy ? "Pinging" : "Ping"}
        </button>
      </form>
      {round && (
        <div className="round" data-status={round.status}>
          <div>
            <span className="who">{round.ping.author}</span> {round.ping.text}
            {round.ping.id && <span className="faint"> #{round.ping.id}</span>}
          </div>
          {round.replies.map((reply) => (
            <div key={reply.id}>
              <span className="who">{reply.author}</span> {reply.text}
            </div>
          ))}
          <div className="status">
            {round.status === "ponged" ? `round trip ${round.ms} ms` : round.status === "waiting" ? "waiting for pong" : round.status}
          </div>
        </div>
      )}
    </section>
  );
}
