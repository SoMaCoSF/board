import type { ReactNode } from "react";
import { Check, Loader, Lock, Minus, X } from "lucide-react";
import type { Fix, Status, Step } from "@/lib/setup";
import { Copy } from "./copy";

const LABEL: Record<Status, string> = {
  done: "done",
  todo: "to do",
  waiting: "waiting",
  skipped: "optional",
  locked: "locked",
  error: "error",
};

function Marker({ status, n }: { status: Status; n: number }): ReactNode {
  const icon = { size: 14, strokeWidth: 2.5, "aria-hidden": true } as const;
  if (status === "done") return <Check {...icon} />;
  if (status === "waiting") return <Loader {...icon} className="spin" />;
  if (status === "error") return <X {...icon} />;
  if (status === "locked") return <Lock {...icon} />;
  if (status === "skipped") return <Minus {...icon} />;
  return <span>{n}</span>;
}

/** What to do: a line each, then each command in its own box. */
function Fixes({ fix }: { fix: Fix[] }): ReactNode {
  return (
    <ol className="fix">
      {fix.map((item, i) => (
        <li key={i}>
          <p>{item.text}</p>
          {item.commands?.map((command) => (
            <div key={command} className="command">
              <pre>
                <code>{command}</code>
              </pre>
              <Copy text={command} />
            </div>
          ))}
          {item.link?.post ? (
            // A write, from this page: its route checks the Origin, and comes back here when it's done.
            <form method="post" action={item.link.href}>
              <button className="button" type="submit">
                {item.link.label}
              </button>
            </form>
          ) : item.link ? (
            <a className="button secondary" href={item.link.href} target="_blank" rel="noreferrer">
              {item.link.label}
            </a>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** The steps, in order: the current one open with what to do, the rest in a line. */
export function Stepper({ steps, current }: { steps: Step[]; current: string | undefined }): ReactNode {
  return (
    <ol className="stepper">
      {steps.map((step, i) => {
        // Optional steps stay open too: optional, but all on display.
        const open = step.id === current || step.status === "error" || step.status === "waiting" || (!!step.optional && step.status !== "done");
        return (
          <li key={step.id} className="step" data-status={step.status} data-current={step.id === current ? "" : undefined}>
            <span className="marker">
              <Marker status={step.status} n={i + 1} />
            </span>
            <div className="step-body">
              <div className="step-head">
                <h2>{step.title}</h2>
                <span className="status">{LABEL[step.status]}</span>
              </div>
              {step.summary ? <p className="summary">{step.summary}</p> : null}
              {open && step.rows?.length ? (
                <dl className="rows">
                  {step.rows.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {open && step.fix?.length ? <Fixes fix={step.fix} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
