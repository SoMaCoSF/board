import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { CopyButton, PackageInstall } from "@/components/code";

type PreProps = ComponentProps<"pre"> & { "data-title"?: string; "data-install"?: string };

function Pre({ "data-title": title, "data-install": install, children, ...props }: PreProps): ReactNode {
  if (install !== undefined) return <PackageInstall command={install} />;
  return (
    <figure className="code">
      {title ? <figcaption className="code-title">{title}</figcaption> : null}
      <pre {...props}>{children}</pre>
      <CopyButton />
    </figure>
  );
}

function Table(props: ComponentProps<"table">): ReactNode {
  return (
    <div className="table">
      <table {...props} />
    </div>
  );
}

function DocLink({ href = "", ...props }: ComponentProps<"a">): ReactNode {
  if (href.startsWith("/")) return <Link href={href} {...props} />;
  if (href.startsWith("#")) return <a href={href} {...props} />;
  return <a href={href} target="_blank" rel="noreferrer" {...props} />;
}

export const components = { pre: Pre, table: Table, a: DocLink };
