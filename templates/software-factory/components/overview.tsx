import type { ReactNode } from "react";
import { FIRST_TASK_PATH } from "@/lib/first-task";
import type { Running } from "@/lib/launcher";
import { ago, firstTaskLine, onboarding } from "@/lib/markdown";
import { duration } from "@/lib/overview";
import { Action } from "./action";
import { Copy } from "./copy";

/** A command, or a line to send, on one line beside its copy button. */
export function Command({ text }: { text: string }): ReactNode {
  return (
    <div className="command">
      <pre>
        <code>{text}</code>
      </pre>
      <Copy text={text} />
    </div>
  );
}

/** One number in a card of its own, and what it counts. */
function Stat({ value, label }: { value: string; label: string }): ReactNode {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * What the factory has been doing, once it runs, as wide as the window: its first task while that's
 * open, the week in its channels and its pull requests in numbers, its repos, and how to watch it.
 */
export function Overview({ running: { overview, repos, ask, first, join }, inspect, now }: { running: Running; inspect: string; now: Date }): ReactNode {
  const { week, lastReplyAt, pulls } = overview;
  const plus = week.more ? "+" : "";
  return (
    <div className="dash">
      {first ? (
        <section className="card first">
          <div>
            <h2>First task</h2>
            <p>{firstTaskLine(first, ask)}</p>
          </div>
          {first === "offer" ? <Action label="Start" path={FIRST_TASK_PATH} /> : null}
        </section>
      ) : null}
      <div className="groups">
        <section>
          <h2>This week</h2>
          <dl className="stats week">
            <Stat value={`${week.threads}${plus}`} label="threads" />
            <Stat value={`${week.messages}${plus}`} label="messages" />
            <Stat value={String(week.answered)} label="answered" />
            {week.firstReplyMs === null ? null : <Stat value={duration(week.firstReplyMs)} label="to first reply" />}
            {lastReplyAt ? <Stat value={ago(lastReplyAt, now)} label="last reply" /> : null}
          </dl>
        </section>
        <section>
          <h2>Pull requests</h2>
          <dl className="stats">
            <Stat value={String(pulls.open)} label="open" />
            <Stat value={String(pulls.merged)} label="merged" />
            <Stat value={String(pulls.closed)} label="closed" />
          </dl>
        </section>
      </div>
      <div className="pair">
        <section className="card">
          <h2>Repos</h2>
          <ul className="rows">
            {repos.map(({ repo, channel }) => (
              <li key={repo}>
                {repo}
                <span>{channel}</span>
              </li>
            ))}
          </ul>
          <p className="note">{onboarding(ask)}</p>
          <Command text="onboard <owner>/<repo>" />
        </section>
        <section className="card">
          <h2>Watch the board</h2>
          <Command text={inspect} />
          <p className="note">
            Want to join with a local coding agent? <Copy text={join} label="Copy this prompt" quiet />
          </p>
        </section>
      </div>
    </div>
  );
}
