import { getDoc, getDocs, getSource } from "@/lib/docs";

// `/quickstart.md` rewrites here (next.config.ts); `/index.md` is the home page.
type Context = { params: Promise<{ slug: string[] }> };

export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ slug: string[] }[]> {
  return (await getDocs()).map(({ slug }) => ({ slug: slug.length ? slug : ["index"] }));
}

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { slug } = await params;
  const doc = await getDoc(slug.join("/") === "index" ? [] : slug);
  if (!doc) return new Response("Not found", { status: 404 });
  return new Response(await getSource(doc), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
