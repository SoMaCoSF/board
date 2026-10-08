import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { InlineCode } from "@/components/inline-code";
import { Toc } from "@/components/toc";
import { editUrl, getDoc, getDocs } from "@/lib/docs";
import { renderMarkdown } from "@/lib/markdown";

type Props = { params: Promise<{ slug: string[] }> };

export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ slug: string[] }[]> {
  return (await getDocs()).filter((doc) => doc.slug.length).map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = await getDoc((await params).slug);
  if (!doc) return {};
  const images = [{ url: `/og${doc.href}`, width: 1200, height: 630 }];
  // Summaries mark code with backticks; meta tags are plain text.
  const description = doc.description.replaceAll("`", "");
  return {
    title: doc.title,
    description,
    openGraph: { title: doc.title, description, images },
    twitter: { images },
  };
}

export default async function DocPage({ params }: Props): Promise<ReactNode> {
  const { slug } = await params;
  const [doc, docs] = await Promise.all([getDoc(slug), getDocs()]);
  if (!doc) notFound();
  const { content, headings } = await renderMarkdown(doc, docs);
  const index = docs.indexOf(doc);
  const previous = docs[index - 1];
  const next = docs[index + 1];

  return (
    <>
      <main className="page">
        <h1 className="page-title">{doc.title}</h1>
        <p className="page-lede">
          <InlineCode text={doc.description} />
        </p>
        <div className="prose">{content}</div>
        <nav className="pager" aria-label="Pages">
          {previous ? (
            <Link href={previous.href}>
              <span>previous</span>← {previous.title}
            </Link>
          ) : null}
          {next ? (
            <Link href={next.href}>
              <span>next</span>
              {next.title} →
            </Link>
          ) : null}
        </nav>
      </main>
      <Toc
        headings={headings.filter(({ depth }) => depth === 2 || depth === 3)}
        markdown={`${doc.href}.md`}
        edit={editUrl(doc)}
      />
    </>
  );
}
