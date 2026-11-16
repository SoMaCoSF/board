import { ROOT, team } from "@/lib/board";
import { snapshot } from "@/lib/campaign";
import { open } from "@/lib/gate";
import { reconcile } from "@/lib/run";

// A campaign's live feed, as server-sent events: a snapshot when it connects, and another after
// every change to the campaign or its tasks. The browser never talks to the board, so it never
// holds a credential. While someone watches, each connection also takes a turn at reconciling the
// campaign, so its agents get fresh credentials between the cron's runs.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A connection ends before the function would, and the browser's EventSource opens the next. */
const ROTATE_MS = 50_000;

/** A busy campaign redraws the page this often at most: a snapshot reads every task. */
const REDRAW_MS = 3_000;

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("c") ?? "";
  if (!/^c[a-z0-9]{4,16}$/.test(slug)) return new Response("no campaign", { status: 400 });
  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort());
  const timer = setTimeout(() => stop.abort(), ROTATE_MS);
  const encoder = new TextEncoder();
  const drives = !(await open(request.headers.get("host")));

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        // A rotated connection comes back in a second, not the browser's default three.
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        const first = await snapshot(slug);
        if (!first) return send("problem", { message: `The board has no campaign ${slug}.` });
        send("snapshot", first);
        // Reconcile decides for itself whether it's time: one that ran in the last 45 seconds returns at once.
        if (drives) void reconcile(slug).catch((error: unknown) => console.warn(`[campaign] reconcile ${slug}:`, error));
        let cursor = first.cursor;
        let drawn = Date.now();
        while (!stop.signal.aborted) {
          // One long-poll: it answers as soon as something under the campaigns' channel changes, or empty after 20 s.
          const page = await team().poll({ channel: `${ROOT}/`, after: cursor, wait: 20 }, stop.signal);
          cursor = page.cursor;
          if (page.events.length === 0) {
            send("ping", {}); // keeps the connection warm
            continue;
          }
          // However many events land, the page is redrawn once, and not sooner than the last redraw allows.
          const wait = drawn + REDRAW_MS - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          if (stop.signal.aborted) break;
          const next = await snapshot(slug);
          if (next) send("snapshot", next);
          drawn = Date.now();
        }
      } catch (error) {
        if (!stop.signal.aborted) send("problem", { message: (error as Error).message });
      } finally {
        clearTimeout(timer);
        controller.close();
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
  });
}
