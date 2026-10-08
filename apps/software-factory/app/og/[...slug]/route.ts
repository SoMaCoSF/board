import { getDoc, getDocs } from "@/lib/docs";
import { ogImage } from "@/lib/og";

// Each docs page's Open Graph image; Next allows no `opengraph-image` under a catch-all.
type Context = { params: Promise<{ slug: string[] }> };

export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ slug: string[] }[]> {
  return (await getDocs()).filter((doc) => doc.slug.length).map(({ slug }) => ({ slug }));
}

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const doc = await getDoc((await params).slug);
  if (!doc) return new Response("Not found", { status: 404 });
  return ogImage({ title: doc.title });
}
