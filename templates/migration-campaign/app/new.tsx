"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { start } from "./actions";
import { DEFAULTS, MAX_AGENTS, SAMPLE, THINKING, type Config } from "@/lib/config";
import { perMillion, type Model } from "@/lib/models";

// The form a campaign starts from. Everything an agent is told, and everything that bounds what the
// campaign can spend, is a field here: the repository and the change, which models and how many
// agents, how a change is checked and delivered, and the budget.

function Field({ label, hint, size, children }: { label: string; hint?: ReactNode; size?: "half" | "third"; children: ReactNode }) {
  return (
    <label className={`field ${size ?? ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function ModelField({ label, value, onChange, models }: { label: string; value: string; onChange: (id: string) => void; models: Model[] }) {
  const list = useId();
  const picked = models.find((model) => model.id === value);
  return (
    <Field label={label} size="half" hint={picked ? perMillion(picked.price) : models.length ? "Not on AI Gateway's list: its cost won't be counted." : "Any AI Gateway model ID."}>
      <input list={list} value={value} onChange={(event) => onChange(event.target.value.trim())} spellCheck={false} placeholder="creator/model" />
      <datalist id={list}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {perMillion(model.price)}
          </option>
        ))}
      </datalist>
    </Field>
  );
}

export function NewCampaign({ models, canPush, disabled }: { models: Model[]; canPush: boolean; disabled: boolean }) {
  const router = useRouter();
  const [config, setConfig] = useState<Config>(DEFAULTS);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof Config>(key: K, value: Config[K]) => setConfig((now) => ({ ...now, [key]: value }));
  const text = (key: "title" | "repo" | "branch" | "instructions" | "discover" | "setup" | "verify") => ({
    value: config[key],
    onChange: (event: { target: { value: string } }) => set(key, event.target.value),
    spellCheck: false,
  });
  const number = (key: "batch" | "maxTasks" | "rounds" | "budgetUsd" | "minutes" | "vcpus", min: number, max: number) => ({
    type: "number" as const,
    min,
    max,
    value: config[key],
    onChange: (event: { target: { value: string } }) => set(key, Number(event.target.value)),
  });

  const submit = () =>
    startTransition(async () => {
      setProblem(null);
      const result = await start(config);
      if (result.ok) router.push(`/c/${result.slug}`);
      else setProblem(result.problem);
    });

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="group">
        <header>
          <h2>The change</h2>
          <p>What every agent is told. Say what to change, what to leave alone, and what done means.</p>
          <p>
            <button type="button" className="link" onClick={() => setConfig(SAMPLE)}>
              Fill in a sample
            </button>
          </p>
        </header>
        <div className="fields">
          <Field label="Repository" size="half" hint="owner/name on GitHub, or an https git URL.">
            <input {...text("repo")} placeholder="acme/web" required />
          </Field>
          <Field label="Branch" size="half" hint="Empty for the default branch.">
            <input {...text("branch")} placeholder="main" />
          </Field>
          <Field label="Name" hint="What the campaign is called on the board.">
            <input {...text("title")} placeholder="Enzyme to React Testing Library" />
          </Field>
          <Field label="Instructions">
            <textarea {...text("instructions")} rows={7} placeholder="Replace every Enzyme test with React Testing Library. Keep each test's intent and its name. Don't touch snapshots…" required />
          </Field>
        </div>
      </div>

      <div className="group">
        <header>
          <h2>The work</h2>
          <p>Which files, how they&apos;re split into tasks, and the command that says a change is right.</p>
        </header>
        <div className="fields">
          <Field label="Files to migrate" hint="A shell command run in the checkout that prints one path per line.">
            <input {...text("discover")} placeholder={`git grep -l "from 'enzyme'" -- '*.test.tsx'`} required />
          </Field>
          <Field label="Setup" hint="Run once after the clone, before the checkout is copied to every agent. Install dependencies here.">
            <input {...text("setup")} placeholder="pnpm install --frozen-lockfile" />
          </Field>
          <Field
            label="Verify"
            hint={
              <>
                Must exit 0 after each change. <code>{"{files}"}</code> becomes the task&apos;s files. An agent that fails it tries again.
              </>
            }
          >
            <input {...text("verify")} placeholder="pnpm vitest run {files}" />
          </Field>
          <Field label="Files per task" size="third">
            <input {...number("batch", 1, 50)} />
          </Field>
          <Field label="Most tasks" size="third" hint="Files past it are left out, and the campaign says how many.">
            <input {...number("maxTasks", 1, 2000)} />
          </Field>
          <Field label="Tries" size="third" hint="After a failed verify or review, before the task is held for you.">
            <input {...number("rounds", 0, 5)} />
          </Field>
        </div>
      </div>

      <div className="group">
        <header>
          <h2>The swarm</h2>
          <p>How many agents, and which models. Each agent gets one sandbox and takes one task at a time.</p>
        </header>
        <div className="fields">
          <Field label="Agents" hint={`Up to ${MAX_AGENTS}. You can change it while the campaign runs.`}>
            <div className="slider">
              <input type="range" min={1} max={MAX_AGENTS} value={config.agents} onChange={(event) => set("agents", Number(event.target.value))} />
              <output>{config.agents}</output>
            </div>
          </Field>
          <ModelField label="Model" value={config.model} onChange={(id) => set("model", id)} models={models} />
          <Field label="Thinking" size="half">
            <select value={config.thinking} onChange={(event) => set("thinking", event.target.value as Config["thinking"])}>
              {THINKING.map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </Field>
          <label className="field check half">
            <input type="checkbox" checked={config.review} onChange={(event) => set("review", event.target.checked)} />
            <span>A second model reviews each diff</span>
          </label>
          {config.review ? <ModelField label="Reviewer" value={config.reviewModel} onChange={(id) => set("reviewModel", id)} models={models} /> : <span className="field half" />}
          <Field label="vCPUs per sandbox" size="third" hint="2 GB of memory each.">
            <input {...number("vcpus", 1, 8)} />
          </Field>
        </div>
      </div>

      <div className="group">
        <header>
          <h2>The limits</h2>
          <p>Where the changes go, and when the campaign stops whether or not it&apos;s finished.</p>
        </header>
        <div className="fields">
          <Field
            label="Deliver as"
            hint={canPush ? "Pull requests and the branch are pushed with this deployment's GITHUB_TOKEN." : "Set GITHUB_TOKEN on this deployment to open pull requests or push a branch."}
          >
            <select value={config.delivery} onChange={(event) => set("delivery", event.target.value as Config["delivery"])}>
              <option value="patch">A patch on each task&apos;s thread</option>
              <option value="prs" disabled={!canPush}>
                A pull request per task
              </option>
              <option value="branch" disabled={!canPush}>
                Commits on one campaign branch
              </option>
            </select>
          </Field>
          <Field label="Budget, in dollars" size="half" hint="What the models may cost. Past it, the agents stop.">
            <input {...number("budgetUsd", 1, 10000)} />
          </Field>
          <Field label="Time limit, in minutes" size="half">
            <input {...number("minutes", 5, 300)} />
          </Field>
        </div>
      </div>

      {problem && <p className="problem">{problem}</p>}
      <div className="submit">
        <button className="primary" type="submit" disabled={pending || disabled}>
          {pending ? "Starting…" : `Start with ${config.agents} ${config.agents === 1 ? "agent" : "agents"}`}
        </button>
        <span className="faint">
          Up to ${config.budgetUsd} and {config.minutes} minutes.
        </span>
      </div>
    </form>
  );
}
