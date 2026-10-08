import assert from "node:assert/strict";
import { test } from "node:test";
import GithubSlugger from "github-slugger";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { getDocs, getNav, isRelative, linkHref } from "../lib/docs.ts";

const textOf = (node) => (typeof node.value === "string" ? node.value : (node.children ?? []).map(textOf).join(""));

/** A page's heading anchors as the site and GitHub make them, and the links it holds. */
function read(doc) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(doc.body);
  const slugger = new GithubSlugger();
  const anchors = new Set();
  const links = [];
  visit(tree, (node) => {
    if (node.type === "heading") anchors.add(slugger.slug(textOf(node)));
    if (node.type === "link" || node.type === "definition") links.push(node.url);
  });
  return { anchors, links };
}

test("the docs ship as pages in the package, grouped by folder", async () => {
  const nav = await getNav();
  assert.equal(nav[0].label, null);
  assert.deepEqual(nav[0].docs.slice(0, 2).map((doc) => doc.href), ["/", "/quickstart"]);
  assert.deepEqual(nav.slice(1).map((group) => group.label), ["Board", "Sync", "Guides", "Reference"]);
  for (const doc of await getDocs()) assert.ok(doc.title && doc.description, doc.file);
});

test("every link between pages lands on a page, and on a heading when it names one", async () => {
  const docs = await getDocs();
  const pages = new Map(docs.map((doc) => [doc.href, read(doc)]));
  const broken = [];
  for (const doc of docs) {
    for (const url of pages.get(doc.href).links) {
      if (!isRelative(url) && !url.startsWith("#")) continue;
      let href;
      try {
        href = url.startsWith("#") ? `${doc.href}${url}` : linkHref(doc, docs, url);
      } catch {
        broken.push(`${doc.file}: ${url} isn't a page`);
        continue;
      }
      const [path, anchor] = href.split("#");
      if (anchor && !pages.get(path).anchors.has(anchor)) broken.push(`${doc.file}: ${url} has no such heading`);
    }
  }
  assert.deepEqual(broken, []);
});

test("a relative link resolves against the page it's on", async () => {
  const docs = await getDocs();
  const watchers = docs.find((doc) => doc.file === "01-board/05-watchers.md");
  assert.equal(linkHref(watchers, docs, "../02-sync/03-slack.md#files"), "/sync/slack#files");
  assert.equal(linkHref(watchers, docs, "./04-reading.md"), "/board/reading");
  assert.equal(linkHref(watchers, docs, "../index.md"), "/");
  assert.throws(() => linkHref(watchers, docs, "./nope.md"), /isn't a page/);
});
