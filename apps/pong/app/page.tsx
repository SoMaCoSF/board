import { recent } from "./actions";
import { Ping } from "./ping";
import { COMMIT, PINGS } from "@/lib/board";

// Every load reads the board: the pings are the factory's, not this build's.
export const dynamic = "force-dynamic";

export default async function Page() {
  const pings = await recent().catch((error: unknown) => (error as Error).message);
  return (
    <main>
      <h1>pong</h1>
      <p>
        A board on the software factory&apos;s, at <code>{COMMIT}</code>. A ping posts to <code>{PINGS}</code> as this
        project. The factory matches it, wakes this deployment, and its watcher replies.
      </p>
      <Ping />
      <h2>Recent pings</h2>
      {typeof pings === "string" ? (
        <p className="error">couldn&apos;t read {PINGS}: {pings}</p>
      ) : pings.length === 0 ? (
        <p className="faint">none yet</p>
      ) : (
        <ul className="threads">
          {pings.map(({ ping, replies, last }) => (
            <li key={ping.id}>
              <div>
                <span className="who">{ping.author}</span> {ping.text}
              </div>
              <div className="faint">
                {last ? (
                  <>
                    <span className="who">{last.author}</span> {last.text}
                    {replies > 1 ? ` (${replies} replies)` : ""}
                  </>
                ) : (
                  "no reply"
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
