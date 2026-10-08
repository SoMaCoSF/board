"use client";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type SearchEntry = {
  href: string;
  page: string;
  section: string | null;
  text: string;
};

const LIMIT = 12;

function rank(entries: SearchEntry[], query: string): SearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries.filter((entry) => !entry.section);
  return entries
    .map((entry) => {
      const page = entry.page.toLowerCase();
      const section = entry.section?.toLowerCase() ?? "";
      const text = entry.text.toLowerCase();
      let score = 0;
      for (const word of words) {
        const hit = (page.includes(word) ? 4 : 0) + (section.includes(word) ? 2 : 0) + (text.includes(word) ? 1 : 0);
        if (!hit) return { entry, score: 0 };
        score += hit;
      }
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map(({ entry }) => entry);
}

const optionId = (index: number): string => `search-result-${index}`;

/** The header's search button and its ⌘K dialog. */
export function Search(): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const index = useRef<Promise<SearchEntry[]>>(undefined);
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const results = useMemo(() => rank(entries, query), [entries, query]);

  const open = (): void => {
    index.current ??= fetch("/search.json").then((response) => {
      if (!response.ok) throw new Error(`search.json: ${response.status}`);
      return response.json() as Promise<SearchEntry[]>;
    });
    setFailed(false);
    index.current.then(setEntries, () => {
      index.current = undefined;
      setFailed(true);
    });
    dialog.current?.showModal();
    input.current?.select();
  };

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (entry: SearchEntry | undefined): void => {
    if (!entry) return;
    dialog.current?.close();
    router.push(entry.href);
  };

  const navigate = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + results.length) % Math.max(results.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    }
  };

  const follow = (event: MouseEvent<HTMLAnchorElement>, entry: SearchEntry): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(entry);
  };

  return (
    <>
      <button type="button" className="search-trigger" onClick={open}>
        search <kbd>⌘K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="search"
        aria-label="Search the docs"
        onClick={(event) => event.target === dialog.current && dialog.current.close()}
      >
        <input
          ref={input}
          type="search"
          role="combobox"
          placeholder="Search the docs"
          aria-label="Search the docs"
          aria-expanded={results.length > 0}
          aria-controls="search-results"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={navigate}
        />
        <ul id="search-results" role="listbox" aria-label="Results" hidden={!results.length}>
          {results.map((entry, i) => (
            <li
              key={entry.href}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
            >
              <a href={entry.href} tabIndex={-1} onClick={(event) => follow(event, entry)}>
                {entry.section ?? entry.page}
                {entry.section ? <span>{entry.page}</span> : null}
              </a>
            </li>
          ))}
        </ul>
        {results.length ? null : (
          <p className="empty">
            {failed ? "Search failed to load. Close and try again." : entries.length ? "No results." : "Loading…"}
          </p>
        )}
      </dialog>
    </>
  );
}
