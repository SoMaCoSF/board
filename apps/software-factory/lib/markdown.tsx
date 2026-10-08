import type { Element, ElementContent, Root as Hast, RootContent as HastContent } from "hast";
import type { Paragraph, Root as Mdast } from "mdast";
import type { ReactNode } from "react";
import type { Highlighter } from "shiki";
import GithubSlugger from "github-slugger";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createCssVariablesTheme, createHighlighter } from "shiki";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { type Doc, isRelative, linkHref } from "@/lib/docs";
import { components } from "@/lib/markdown-components";

export type Heading = { id: string; depth: number; text: string };

/** One heading's worth of a page, for search. */
export type Section = { id: string | null; title: string | null; text: string };

type Node = { type: string; value?: unknown; children?: Node[] };

const textOf = (node: Node): string =>
  typeof node.value === "string" ? node.value : (node.children ?? []).map(textOf).join("");

/** GitHub's alert kinds, which GitHub renders the same way. */
const ALERTS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/** `> [!NOTE]`, `> [!TIP]`, and `> [!WARNING]` blockquotes become callouts. */
function remarkAlerts() {
  return (tree: Mdast) => {
    visit(tree, "blockquote", (node) => {
      const [first] = node.children;
      if (first?.type !== "paragraph") return;
      const [text] = first.children;
      const marker = text?.type === "text" ? /^\[!(\w+)\]\s*/.exec(text.value) : null;
      if (text?.type !== "text" || !marker || !Object.hasOwn(ALERTS, marker[1]!)) return;
      text.value = text.value.slice(marker[0].length);
      if (!text.value) first.children.shift();
      if (!first.children.length) node.children.shift();
      const label: Paragraph = {
        type: "paragraph",
        data: { hName: "span", hProperties: { className: ["callout-label"] } },
        children: [{ type: "text", value: ALERTS[marker[1]!]! }],
      };
      node.children.unshift(label);
      node.data = { hName: "aside", hProperties: { className: ["callout"], dataKind: marker[1]!.toLowerCase() } };
    });
  };
}

/** Relative links between pages (`../02-sync/03-slack.md`) become site URLs; a broken one fails the build. */
function remarkLinks(doc: Doc, docs: Doc[]) {
  return () => (tree: Mdast) => {
    visit(tree, (node) => {
      if ((node.type === "link" || node.type === "definition") && isRelative(node.url)) {
        node.url = linkHref(doc, docs, node.url);
      }
    });
  };
}

/** GitHub-style heading ids, so a page's anchors match the same file on GitHub. */
function rehypeHeadings(headings: Heading[]) {
  return () => (tree: Hast) => {
    const slugger = new GithubSlugger();
    visit(tree, "element", (node) => {
      const depth = /^h([1-6])$/.exec(node.tagName)?.[1];
      if (!depth) return;
      const text = textOf(node);
      const id = slugger.slug(text);
      node.properties.id = id;
      node.children = [
        { type: "element", tagName: "a", properties: { className: ["anchor"], href: `#${id}` }, children: node.children },
      ];
      headings.push({ id, depth: Number(depth), text });
    });
  };
}

let highlighter: Promise<Highlighter> | undefined;

const LANGS = ["ts", "tsx", "js", "json", "bash", "sh", "yaml"];

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    themes: [createCssVariablesTheme({ name: "css-variables", variablePrefix: "--shiki-" })],
    langs: LANGS,
  });
  return highlighter;
}

/** Highlights fences, keeps their title (```ts app/api/board/route.ts), and marks package installs. */
function rehypeCode(shiki: Highlighter) {
  return () => (tree: Hast) => {
    visit(tree, "element", (node) => {
      const [code] = node.children;
      if (node.tagName !== "pre" || code?.type !== "element" || code.tagName !== "code") return;
      const className = Array.isArray(code.properties.className) ? code.properties.className : [];
      const lang = String(className.find((name) => String(name).startsWith("language-")) ?? "").slice(9);
      const meta = (code.data as { meta?: string } | undefined)?.meta?.trim();
      const source = textOf(code).replace(/\n$/, "");
      if (lang === "package-install") {
        node.properties = { dataInstall: source };
        node.children = [];
        return;
      }
      if (lang && lang !== "text" && !LANGS.includes(lang)) {
        throw new Error(`No highlighting for \`${lang}\` fences; add it to LANGS`);
      }
      const root = shiki.codeToHast(source, { lang: lang || "text", theme: "css-variables" });
      const pre = root.children[0] as Element;
      node.properties = { ...pre.properties, dataTitle: meta || undefined };
      node.children = pre.children as ElementContent[];
    });
  };
}

/** Under a `## FAQ` heading, each `###` question folds its answer into a `<details>`. */
function rehypeFaq() {
  return (tree: Hast) => {
    const children: HastContent[] = [];
    let faq = false;
    let open: Element | undefined;
    for (const node of tree.children) {
      const tag = node.type === "element" ? node.tagName : undefined;
      if (tag === "h2") {
        faq = textOf(node) === "FAQ";
        open = undefined;
      } else if (faq && tag === "h3" && node.type === "element") {
        const summary: Element = { type: "element", tagName: "summary", properties: {}, children: [{ type: "text", value: textOf(node) }] };
        open = { type: "element", tagName: "details", properties: { id: node.properties.id }, children: [summary] };
        children.push(open);
        continue;
      }
      if (open && tag !== "h2") open.children.push(node as ElementContent);
      else children.push(node);
    }
    tree.children = children;
  };
}

const UNSEARCHED = new Set(["comment"]);

/** Plain text per heading, for the search index. */
function rehypeSections(sections: Section[]) {
  return () => (tree: Hast) => {
    let current: Section = { id: null, title: null, text: "" };
    sections.push(current);
    for (const node of tree.children) {
      if (node.type === "element" && /^h[23]$/.test(node.tagName)) {
        current = { id: String(node.properties.id), title: textOf(node), text: "" };
        sections.push(current);
      } else if (!(node.type === "element" && node.tagName === "pre") && !UNSEARCHED.has(node.type)) {
        current.text += ` ${textOf(node)}`;
      }
    }
    for (const section of sections) section.text = section.text.replace(/\s+/g, " ").trim();
  };
}

export async function renderMarkdown(doc: Doc, docs: Doc[]): Promise<{ content: ReactNode; headings: Heading[] }> {
  const headings: Heading[] = [];
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkAlerts)
    .use(remarkLinks(doc, docs))
    .use(remarkRehype)
    .use(rehypeHeadings(headings))
    .use(rehypeCode(await getHighlighter()))
    .use(rehypeFaq);
  const tree = await processor.run(processor.parse(doc.body));
  return { content: toJsxRuntime(tree, { Fragment, jsx, jsxs, components }), headings };
}

export async function sectionsOf(doc: Doc): Promise<Section[]> {
  const sections: Section[] = [];
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeHeadings([]))
    .use(rehypeSections(sections));
  await processor.run(processor.parse(doc.body));
  return sections;
}
