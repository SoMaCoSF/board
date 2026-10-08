"use client";
import type { MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Copies its code block's text. */
export function CopyButton(): ReactNode {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);

  const copy = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    const pre = event.currentTarget.closest(".code")?.querySelector("pre");
    if (!pre) return;
    await navigator.clipboard.writeText(pre.innerText);
    setCopied(true);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      className="copy"
      aria-label={copied ? "Copied" : "Copy code"}
      data-copied={copied || undefined}
      onClick={copy}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

const MANAGERS = [
  ["npm", "npm install"],
  ["pnpm", "pnpm add"],
  ["yarn", "yarn add"],
  ["bun", "bun add"],
] as const;

/** A ```package-install fence: one `npm i …` line, shown for each package manager. */
export function PackageInstall({ command }: { command: string }): ReactNode {
  const [selected, setSelected] = useState(0);
  const packages = command.replace(/^npm\s+(i|install|add)\s+/, "");
  return (
    <figure className="code">
      <figcaption className="code-title">
        <span className="code-tabs" role="tablist" aria-label="Package manager">
          {MANAGERS.map(([name], index) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={index === selected}
              onClick={() => setSelected(index)}
            >
              {name}
            </button>
          ))}
        </span>
      </figcaption>
      <pre>
        {MANAGERS[selected]![1]} {packages}
      </pre>
      <CopyButton />
    </figure>
  );
}
