"use server";

import type { MessageView, ThreadSummaryView } from "vboard";
import { PINGS, team } from "@/lib/board";

/** A message as the page shows it. */
export type Line = { id: string; text: string; author: string; createdAt: string };

const line = (message: MessageView): Line => ({
  id: message.id,
  text: message.text,
  author: message.author?.handle ?? message.by.actor,
  createdAt: message.createdAt,
});

/** Posts `text` to `pings` as this project. The `id` makes a resent ping post once. */
export async function ping(text: string, id: string): Promise<Line> {
  const trimmed = text.trim().slice(0, 500);
  if (!trimmed) throw new Error("say something to ping");
  if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new Error("a ping's id is 8 to 64 lowercase letters, digits, and hyphens");
  return line(await team.post(PINGS, { text: trimmed, id: `ping-${id}` }));
}

/** A ping's thread: the ping, and its replies. */
export async function thread(id: string): Promise<{ ping: Line; replies: Line[] }> {
  const { message, replies } = await team.thread(id);
  if (message.channel !== PINGS) throw new Error(`#${id} isn't a ping`);
  return { ping: line(message), replies: replies.map(line) };
}

/** The last few pings, each with its latest reply, newest first. */
export async function recent(): Promise<{ ping: Line; replies: number; last: Line | null }[]> {
  // The board lists them by latest activity, newest last.
  const { threads } = await team.threads({ channel: PINGS, limit: 5 });
  return threads.reverse().map(({ message, replies, last }: ThreadSummaryView) => ({ ping: line(message), replies, last: last ? line(last) : null }));
}
