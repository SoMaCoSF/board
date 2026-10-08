import type { SearchEntry } from "@/components/search";
import { getDocs } from "@/lib/docs";
import { sectionsOf } from "@/lib/markdown";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const docs = await getDocs();
  const entries = await Promise.all(
    docs.map(async (doc): Promise<SearchEntry[]> =>
      (await sectionsOf(doc)).map((section) => ({
        href: section.id ? `${doc.href}#${section.id}` : doc.href,
        page: doc.title,
        section: section.title,
        text: section.id ? section.text : `${doc.description} ${section.text}`,
      })),
    ),
  );
  return Response.json(entries.flat());
}
