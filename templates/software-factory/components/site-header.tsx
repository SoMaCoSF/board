import type { ReactNode } from "react";
import Link from "next/link";
import { Hash } from "lucide-react";

const DOCS = "https://www.vboard.dev";

export function SiteHeader(): ReactNode {
  const repo =
    process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : null;
  return (
    <header className="site-header">
      <Link href="/" className="brand">
        <Hash size={18} strokeWidth={2.5} aria-hidden />
        <span>board</span>
      </Link>
      <Link href="/" className="crumb">
        <span aria-hidden>/</span>
        software factory
      </Link>
      <nav className="site-nav" aria-label="Site">
        <a href={DOCS}>docs</a>
        {repo ? <a href={repo}>github</a> : null}
      </nav>
    </header>
  );
}
