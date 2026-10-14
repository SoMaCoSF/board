import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { cache } from "react";
import { parse } from "yaml";

/** The docs ship in the vboard package (`docs/`), so the site reads them from its install. */
const ROOT = join(process.cwd(), "node_modules/vboard/docs");

export type Doc = {
  /** URL segments, without the numeric ordering prefixes. */
  slug: string[];
  href: string;
  /** Source path relative to `docs/`, e.g. `01-board/05-watchers.md`. */
  file: string;
  title: string;
  description: string;
  body: string;
};

export type Group = {
  /** `null` for the pages at the root of `docs/`. */
  label: string | null;
  docs: Doc[];
};

export const REPO = "https://github.com/vercel-labs/vboard";
export const NPM = "https://www.npmjs.com/package/vboard";
export const TAGLINE = "The programmable message board.";

const unprefixed = (name: string): string => name.replace(/^\d+-/, "");

const hrefOf = (slug: string[]): string => `/${slug.join("/")}`;

function field(data: Record<string, unknown>, key: string, file: string): string {
  const value = data[key];
  if (typeof value !== "string" || !value) throw new Error(`docs/${file} needs a \`${key}\` in its frontmatter`);
  return value;
}

async function load(file: string): Promise<Doc> {
  const source = await readFile(join(ROOT, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`docs/${file} needs frontmatter`);
  const data = (parse(match[1] ?? "") ?? {}) as Record<string, unknown>;
  const parts = file.replace(/\.md$/, "").split("/").map(unprefixed);
  const slug = parts.join("/") === "index" ? [] : parts;
  return {
    slug,
    href: hrefOf(slug),
    file,
    title: field(data, "title", file),
    description: field(data, "description", file),
    body: match[2] ?? "",
  };
}

/** A folder's pages in filename order, its `index.md` first. */
const pages = async (dir: string): Promise<string[]> =>
  (await readdir(join(ROOT, dir)))
    .filter((name) => name.endsWith(".md"))
    .toSorted((a, b) => (a === "index.md" ? -1 : b === "index.md" ? 1 : a.localeCompare(b)));

/**
 * Every page, grouped as the sidebar shows them: the root pages, then a group per
 * folder, labeled with its name (`02-sync` is "Sync"). Read once per render, so
 * `next dev` shows edits.
 */
export const getNav = cache(async (): Promise<Group[]> => {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).toSorted();
  const root: Group = { label: null, docs: await Promise.all((await pages("")).map(load)) };
  const groups = await Promise.all(
    folders.map(async (dir): Promise<Group> => {
      const name = unprefixed(dir).replaceAll("-", " ");
      const docs = await Promise.all((await pages(dir)).map((page) => load(`${dir}/${page}`)));
      return { label: name[0]!.toUpperCase() + name.slice(1), docs };
    }),
  );
  return [root, ...groups];
});

export async function getDocs(): Promise<Doc[]> {
  return (await getNav()).flatMap((group) => group.docs);
}

export async function getDoc(slug: string[]): Promise<Doc | undefined> {
  const href = hrefOf(slug);
  return (await getDocs()).find((doc) => doc.href === href);
}

/** The page exactly as authored, frontmatter included. */
export function getSource(doc: Doc): Promise<string> {
  return readFile(join(ROOT, doc.file), "utf8");
}

export const editUrl = (doc: Doc): string => `${REPO}/edit/main/packages/vboard/docs/${doc.file}`;

/** A link in a page's markdown is relative when it isn't a URL, an absolute path, or an anchor. */
export const isRelative = (url: string): boolean => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url);

/**
 * Pages link to each other by relative file path (`../02-sync/03-slack.md#files`), so
 * they read the same on GitHub and in node_modules. This is the URL such a link points at.
 */
export function linkHref(from: Doc, docs: Doc[], target: string): string {
  const [path = "", hash] = target.split("#");
  const file = posix.normalize(posix.join(posix.dirname(from.file), path));
  const doc = docs.find((candidate) => candidate.file === file);
  if (!doc) throw new Error(`docs/${from.file} links to ${target}, which isn't a page`);
  return hash ? `${doc.href}#${hash}` : doc.href;
}
