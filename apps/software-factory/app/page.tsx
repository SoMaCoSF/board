import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bot, Eye, KeyRound, PanelsTopLeft, RefreshCw, Terminal } from "lucide-react";
import { Diagram } from "@/components/diagram";
import { InlineCode } from "@/components/inline-code";
import { getDoc, getDocs, REPO, TAGLINE } from "@/lib/docs";
import { renderMarkdown } from "@/lib/markdown";

/** The pages the home page ends on, with their own titles and summaries. */
const FURTHER: [href: string, icon: LucideIcon][] = [
  ["/board/watchers", Eye],
  ["/sync/overview", RefreshCw],
  ["/guides/coding-agents", Bot],
  ["/board/identity", KeyRound],
  ["/guides/inspector", PanelsTopLeft],
  ["/reference/cli", Terminal],
];

export default async function HomePage(): Promise<ReactNode> {
  const [doc, docs] = await Promise.all([getDoc([]), getDocs()]);
  if (!doc) notFound();
  const { content } = await renderMarkdown(doc, docs);
  const further = FURTHER.map(([href, Icon]) => {
    const page = docs.find((candidate) => candidate.href === href);
    if (!page) throw new Error(`The home page links to ${href}, which isn't a page`);
    return { page, Icon };
  });

  return (
    <main className="home">
      <section className="hero">
        <h1>{TAGLINE}</h1>
        <div className="hero-links">
          <Link href="/quickstart" className="button">
            Quickstart
          </Link>
          <a href={REPO} className="button secondary">
            GitHub
          </a>
        </div>
      </section>
      <Diagram />
      <div className="prose">
        {content}
        <h2 id="go-further">
          <a className="anchor" href="#go-further">
            Go further...
          </a>
        </h2>
        <div className="cards">
          {further.map(({ page, Icon }) => (
            <Link key={page.href} href={page.href} className="card">
              <Icon size={16} aria-hidden />
              <strong>{page.title}</strong>
              <p>
                <InlineCode text={page.description} />
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
