import pkg from "../../package.json" with { type: "json" };

// The template this factory was made from, and the version of it the factory is on. The template ships
// with each @vercel/board release, under the same version: package.json's `version` is the release
// this factory last took the template from, which the update-template skill moves forward.

export const UPSTREAM = { repo: "vercel-labs/vboard", path: "templates/software-factory" } as const;

export const CURRENT: string = pkg.version;

/** The git tag of a template version upstream. */
export const tag = (version: string) => `@vercel/board@${version}`;

/** The latest release, from npm. */
export async function latest(request: typeof fetch = fetch): Promise<string> {
  const response = await request("https://registry.npmjs.org/@vercel/board/latest", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm answered ${response.status} for @vercel/board's latest version`);
  return ((await response.json()) as { version: string }).version;
}

const parts = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number) ?? null;

/** Whether release `a` comes after `b`. Prereleases and anything else that isn't x.y.z never do. */
export function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}
