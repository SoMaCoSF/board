import type { ReactNode } from "react";
import { Sidebar } from "@/components/sidebar";
import { getNav } from "@/lib/docs";

export default async function DocsLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  const groups = (await getNav()).map(({ label, docs }) => ({
    label,
    links: docs.map(({ href, title }) => ({ href, title })),
  }));
  return (
    <div className="docs">
      <Sidebar groups={groups} />
      {children}
    </div>
  );
}
