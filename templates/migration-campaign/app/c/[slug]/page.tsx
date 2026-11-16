import { headers } from "next/headers";
import Link from "next/link";
import { CampaignView } from "./campaign";
import { snapshot } from "@/lib/campaign";
import { OPEN, open } from "@/lib/gate";

// Every load reads the board: a campaign is whatever the board says it is now.
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const valid = /^c[a-z0-9]{4,16}$/.test(slug);
  const [first, isOpen] = await Promise.all([valid ? snapshot(slug).catch((error: unknown) => (error as Error).message) : null, open((await headers()).get("host"))]);
  if (!first || typeof first === "string") {
    return (
      <main className="page">
        <h1>No such campaign</h1>
        <p className="lede">{typeof first === "string" ? `Couldn't read the board: ${first}` : `The board has no campaign ${slug}.`}</p>
        <Link href="/">All campaigns</Link>
      </main>
    );
  }
  return (
    <main className="page">
      {isOpen && <p className="notice">{OPEN}</p>}
      <CampaignView first={first} readOnly={isOpen} />
    </main>
  );
}
