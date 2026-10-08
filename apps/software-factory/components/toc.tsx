"use client";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { Heading } from "@/lib/markdown";

type Copy = "idle" | "copied" | "failed";

/** The heading nearest above this line counts as the one being read. */
const READING_LINE = 120;

export function Toc({ headings, markdown, edit }: { headings: Heading[]; markdown: string; edit: string }): ReactNode {
  const [current, setCurrent] = useState<string>();
  const [copy, setCopy] = useState<Copy>("idle");
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const elements = headings.flatMap(({ id }) => document.getElementById(id) ?? []);
    let frame = 0;
    const update = (): void => {
      frame = 0;
      const above = elements.filter((element) => element.getBoundingClientRect().top < READING_LINE);
      setCurrent(above.at(-1)?.id);
    };
    const schedule = (): void => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [headings]);

  useEffect(() => () => clearTimeout(reset.current), []);

  // Safari only lets a click write the clipboard synchronously, so the
  // fetch goes into the ClipboardItem as a promise instead of being awaited.
  const copyPage = (): void => {
    const source = fetch(markdown)
      .then((response) => response.text())
      .then((text) => new Blob([text], { type: "text/plain" }));
    const show = (next: Copy): void => {
      setCopy(next);
      clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopy("idle"), 1500);
    };
    navigator.clipboard.write([new ClipboardItem({ "text/plain": source })]).then(
      () => show("copied"),
      () => show("failed"),
    );
  };

  return (
    <aside className="toc">
      {headings.length ? (
        <>
          <p className="label">On this page</p>
          <ul>
            {headings.map((heading) => (
              <li key={heading.id} className={`depth-${heading.depth}`}>
                <a href={`#${heading.id}`} aria-current={heading.id === current ? "true" : undefined}>
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="label">Page</p>
      <div className="page-actions">
        <button type="button" onClick={copyPage}>
          {copy === "idle" ? "copy as markdown" : copy}
        </button>
        <a href={markdown}>view as markdown</a>
        <a href={edit}>edit on github</a>
      </div>
    </aside>
  );
}
