"use client";

import type { ReactNode } from "react";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/** Runs the checks again: on a click, and every few seconds while a step is waiting on something to happen. */
export function Refresh({ waiting }: { waiting: boolean }): ReactNode {
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => start(() => router.refresh()), 5_000);
    return () => clearInterval(timer);
  }, [waiting, router]);
  return (
    <button type="button" className="button secondary" disabled={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw size={14} aria-hidden className={pending ? "spin" : undefined} />
      {pending ? "Checking" : "Check again"}
    </button>
  );
}
