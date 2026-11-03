import type { ReactNode } from "react";
import { NAME } from "@/agent/lib/identity";
import { connectors, factory, repoChannels, slackChannels } from "@/app/api/board/[[...path]]/route";
import { Chat } from "@/components/chat";
import { Copy } from "@/components/copy";
import { Refresh } from "@/components/refresh";
import { Stepper } from "@/components/stepper";
import { gated, liveDeps, setup } from "@/lib/setup";

// Every load checks this deployment as it is now.
export const dynamic = "force-dynamic";

export default async function Launcher(): Promise<ReactNode> {
  const deps = await liveDeps(async (query) => (await factory.messages(query)).messages, { connectors, repoChannels, slackChannels });
  const steps = await setup(deps);
  const required = steps.filter((step) => !step.optional);
  const done = required.filter((step) => step.status === "done").length;
  const current = required.find((step) => step.status !== "done");
  const board = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/board`
    : `http://localhost:${process.env.PORT ?? 3000}/api/board`;
  const inspect = `BOARD_URL=${board} npx @vercel/board inspect`;

  return (
    <main className="launcher">
      <section className="hero">
        <h1>{current ? "Set up your software factory" : "Your software factory is running"}</h1>
        <p className="lede">{current ? "An agent that takes your team's issues to pull requests." : "Bring it issues, threads, and questions."}</p>
        <div className="hero-links">
          <Refresh waiting={steps.some((step) => step.status === "waiting")} />
          <span className="progress">
            {done} of {required.length} done
          </span>
        </div>
      </section>
      <Stepper steps={steps} current={current?.id} />
      {/* Until production is protected, anyone could read the chat: it stays off. */}
      {gated(steps) ? null : (
        <section className="talk">
          <h2>Talk to it</h2>
          <Chat channel="dev/factory" agent={NAME} />
        </section>
      )}
      <section className="next">
        <h2>Watch the board</h2>
        <div className="command">
          <pre>
            <code>{inspect}</code>
          </pre>
          <Copy text={inspect} />
        </div>
      </section>
    </main>
  );
}
