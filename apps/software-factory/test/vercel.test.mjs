import assert from "node:assert/strict";
import { test } from "node:test";
import { authorize, memoryStore, vercelToken, VERCEL_APP } from "../app/api/board/[[...path]]/vercel.ts";

// A token endpoint that rotates refresh tokens like Vercel's: each one works once.
function endpoint() {
  const calls = [];
  let n = 0;
  const live = new Set();
  const fetcher = async (_url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push(body);
    if (body.client_assertion_type !== "urn:vercel:params:oauth:client-assertion-type:oidc-bearer" || body.client_id !== VERCEL_APP) {
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    }
    if (body.grant_type === "refresh_token" && !live.delete(body.refresh_token)) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    n += 1;
    live.add(`refresh-${n}`);
    return new Response(JSON.stringify({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 }));
  };
  return { fetcher, calls };
}

test("nobody has authorized the app: no token, and no call to Vercel", async () => {
  const { fetcher, calls } = endpoint();
  assert.equal(await vercelToken({ oidc: "oidc", store: memoryStore(), fetch: fetcher }), undefined);
  assert.equal(calls.length, 0);
});

test("authorizing trades the code with the OIDC token as the client assertion, and Pi gets that access token", async () => {
  const { fetcher, calls } = endpoint();
  const store = memoryStore();
  await authorize({ oidc: "oidc", code: "c", verifier: "v", redirectUri: "https://x/cb", store, fetch: fetcher });
  assert.deepEqual(calls[0], {
    grant_type: "authorization_code",
    code: "c",
    code_verifier: "v",
    redirect_uri: "https://x/cb",
    client_id: VERCEL_APP,
    client_assertion_type: "urn:vercel:params:oauth:client-assertion-type:oidc-bearer",
    client_assertion: "oidc",
  });
  assert.equal(await vercelToken({ oidc: "oidc", store, fetch: fetcher }), "access-1");
  assert.equal(calls.length, 1);
});

test("an expired access token is refreshed with the latest refresh token, which rotates", async () => {
  const { fetcher, calls } = endpoint();
  const store = memoryStore();
  await authorize({ oidc: "oidc", code: "c", verifier: "v", redirectUri: "https://x/cb", store, fetch: fetcher });
  for (const expected of ["access-2", "access-3"]) {
    await store.del("vercel-app:access");
    assert.equal(await vercelToken({ oidc: "oidc", store, fetch: fetcher }), expected);
  }
  assert.deepEqual(calls.slice(1).map((c) => c.refresh_token), ["refresh-1", "refresh-2"]);
});

test("turns starting together refresh once: the single-use refresh token isn't spent twice", async () => {
  const { fetcher, calls } = endpoint();
  const store = memoryStore();
  await authorize({ oidc: "oidc", code: "c", verifier: "v", redirectUri: "https://x/cb", store, fetch: fetcher });
  await store.del("vercel-app:access");
  const tokens = await Promise.all([1, 2, 3].map(() => vercelToken({ oidc: "oidc", store, fetch: fetcher })));
  assert.deepEqual(tokens, ["access-2", "access-2", "access-2"]);
  assert.equal(calls.filter((c) => c.grant_type === "refresh_token").length, 1);
});

test("a refused refresh fails loudly and leaves the lock free for the next turn", async () => {
  const store = memoryStore();
  await store.set("vercel-app:refresh", "revoked", { ttlSeconds: 60 });
  const { fetcher } = endpoint();
  await assert.rejects(vercelToken({ oidc: "oidc", store, fetch: fetcher }), /400 invalid_grant/);
  assert.equal(await store.get("vercel-app:lock"), null);
});
