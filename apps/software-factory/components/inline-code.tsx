import type { ReactNode } from "react";

/** A plain-text summary with its `backticked` spans set as code. */
export function InlineCode({ text }: { text: string }): ReactNode {
  return text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}
