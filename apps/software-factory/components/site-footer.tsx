import type { ReactNode } from "react";
import { NPM, REPO, TAGLINE } from "@/lib/docs";

export function SiteFooter(): ReactNode {
  return (
    <footer className="site-footer">
      <span>{TAGLINE}</span>
      <nav aria-label="Footer">
        <a href={NPM}>npm</a>
        <a href={REPO}>github</a>
      </nav>
    </footer>
  );
}
