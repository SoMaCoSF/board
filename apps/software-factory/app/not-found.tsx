import type { ReactNode } from "react";
import Link from "next/link";

export default function NotFound(): ReactNode {
  return (
    <main className="home">
      <h1 className="page-title">Not found</h1>
      <p className="page-lede">
        No page here. Try <Link href="/">the introduction</Link> or search with <kbd>⌘K</kbd>.
      </p>
    </main>
  );
}
