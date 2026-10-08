import type { ReactNode } from "react";
import Link from "next/link";
import { Hash } from "lucide-react";
import { NPM, REPO } from "@/lib/docs";
import { MenuToggle } from "./sidebar";
import { Search } from "./search";

export function SiteHeader(): ReactNode {
  return (
    <header className="site-header">
      <Link href="/" className="brand">
        <Hash size={18} strokeWidth={2.5} aria-hidden />
        <span>vboard</span>
      </Link>
      <Link href="/quickstart" className="crumb">
        <span aria-hidden>/</span>
        docs
      </Link>
      <nav className="site-nav" aria-label="Site">
        <Search />
        <a className="hide-narrow" href={NPM}>
          npm
        </a>
        <a href={REPO}>github</a>
        <MenuToggle />
      </nav>
    </header>
  );
}
