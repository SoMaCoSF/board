import assert from "node:assert/strict";
import { test } from "node:test";
import { byWatcher } from "../app/api/board/[[...path]]/agent.ts";
import { helper, helperPolicy, helperSandbox } from "../app/api/board/[[...path]]/helper.ts";
import { forAgent } from "../app/api/board/[[...path]]/kinds.ts";

/** The rule the sandbox's proxy applies to a request: the first whose match holds, as it runs them in order. */
function ruleFor(policy, host, { method, path, query = {} }) {
  const rules = policy.allow[host];
  if (!rules) return null;
  return rules.find(({ match }) => {
    if (!match) return true;
    if (match.method && !match.method.includes(method)) return false;
    if (match.path && !new RegExp(match.path.regex).test(path)) return false;
    return (match.queryString ?? []).every(({ key, value }) => query[key.exact] === value.exact);
  });
}

test("helperPolicy: Helper reads the repo and GitHub's REST API, and can't push or write", () => {
  const policy = helperPolicy("ghs_real");
  const basic = `Basic ${Buffer.from("x-access-token:ghs_real").toString("base64")}`;
  const fetch = ruleFor(policy, "github.com", { method: "GET", path: "/basehub-ai/vboard.git/info/refs", query: { service: "git-upload-pack" } });
  assert.equal(fetch.transform[0].headers.authorization, basic);
  assert.ok(ruleFor(policy, "github.com", { method: "POST", path: "/basehub-ai/vboard.git/git-upload-pack" }).transform);

  const push = ruleFor(policy, "github.com", { method: "GET", path: "/basehub-ai/vboard.git/info/refs", query: { service: "git-receive-pack" } });
  assert.equal(push.response.statusCode, 403);
  assert.equal(ruleFor(policy, "github.com", { method: "POST", path: "/basehub-ai/vboard.git/git-receive-pack" }).response.statusCode, 403);
  assert.equal(ruleFor(policy, "github.com", { method: "POST", path: "/basehub-ai/other.git/git-upload-pack" }).response.statusCode, 403);

  assert.equal(ruleFor(policy, "api.github.com", { method: "GET", path: "/repos/basehub-ai/vboard/pulls/12" }).transform[0].headers.authorization, "Bearer ghs_real");
  for (const method of ["POST", "PATCH", "PUT", "DELETE"])
    assert.equal(ruleFor(policy, "api.github.com", { method, path: "/graphql" }).response.statusCode, 403);

  // Nothing else: no board, no gateway, no wildcard.
  assert.deepEqual(Object.keys(policy.allow).sort(), ["api.github.com", "github.com", "registry.npmjs.org"]);
});

test("helperSandbox: one persistent sandbox per session, with no real credential in it", () => {
  const settings = helperSandbox("thread-812");
  assert.equal(settings.name, "helper-thread-812");
  assert.equal(settings.persistent, true);
  assert.deepEqual(settings.env, { GH_TOKEN: "from-the-network-policy", GIT_TERMINAL_PROMPT: "0" });
});

test("helper: declared with a name, run by the board", () => {
  assert.equal(helper.name, "Helper");
  assert.equal(typeof helper.run, "function");
});

test("forAgent: a thread whose root asks an agent is that agent's", () => {
  assert.equal(forAgent({ mentions: ["vboard:agent:helper"] }), true);
  assert.equal(forAgent({ mentions: ["slack:user:U0456"] }), false);
  assert.equal(forAgent({ mentions: [] }), false);
});

test("byWatcher: the board's notice that an agent couldn't finish wakes no one either", () => {
  assert.equal(byWatcher({ actor: "vboard:agents" }), true);
  assert.equal(byWatcher({ actor: "vboard:watch:triage" }), true);
  assert.equal(byWatcher({ actor: "vboard:agent:helper" }), false);
});
