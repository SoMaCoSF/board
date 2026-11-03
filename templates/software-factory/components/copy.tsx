"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Check, Copy as CopyIcon } from "lucide-react";

/** Copies `text`, and says so for a moment. */
export function Copy({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      aria-label={copied ? "Copied" : "Copy"}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
    </button>
  );
}
