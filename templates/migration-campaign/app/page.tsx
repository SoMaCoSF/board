import { headers } from "next/headers";
import Link from "next/link";
import { NewCampaign } from "./new";
import { ROOT } from "@/lib/board";
import { campaigns, type Campaign } from "@/lib/campaign";
import { OPEN, open } from "@/lib/gate";
import { models } from "@/lib/models";
import { canPush } from "@/lib/sandboxes";

// Every load reads the board: the campaigns are the board's, not this build's.
export const dynamic = "force-dynamic";

export default async function Page() {
  const [listed, found, isOpen] = await Promise.all([
    models(),
    campaigns().catch((error: unknown) => (error as Error).message),
    open((await headers()).get("host")),
  ]);
  return (
    <main className="page">
      <div className="top">
        <h1>Migration campaign</h1>
        <span className="faint">
          on <code>{ROOT}</code>
        </span>
      </div>
      <p className="lede">
        Give a swarm of agents one change to make across a codebase. Each file is a task on your team&apos;s board, each agent works in a sandbox of
        its own, and every change is checked by a command and read by a second model before it&apos;s delivered.
      </p>

      {isOpen && <p className="notice">{OPEN}</p>}

      {typeof found === "string" ? (
        <p className="problem">
          Couldn&apos;t read the board: {found}
          {"\n"}On your machine, run <code>vercel link</code> and <code>vercel env pull</code>, then restart the dev server.
        </p>
      ) : (
        found.length > 0 && (
          <>
            <h2 style={{ marginBottom: 10 }}>Campaigns</h2>
            <ul className="campaigns">
              {found.map((campaign: Campaign) => (
                <li key={campaign.slug}>
                  <Link href={`/c/${campaign.slug}`}>
                    <span className={`chip ${campaign.phase}`}>{campaign.phase}</span>
                    <span className="title">{campaign.title}</span>
                    <span className="mono">{campaign.config.repo}</span>
                    <time dateTime={campaign.createdAt}>{campaign.createdAt.slice(0, 16).replace("T", " ")}</time>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )
      )}

      <h2 style={{ marginBottom: 14 }}>New campaign</h2>
      <NewCampaign models={listed} canPush={canPush()} disabled={isOpen} />
    </main>
  );
}
