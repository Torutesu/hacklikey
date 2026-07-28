"use client";

import { useCallback, useEffect, useState } from "react";
import { AskPanel } from "@/components/AskPanel";
import { TrailLibrary, useTrails } from "@/components/TrailLibrary";
import { TrailReplay } from "@/components/TrailReplay";
import type { Trail } from "@/lib/types";

/**
 * App shell.
 *
 * Two tabs, not more. The live half and the memory half are the product; every
 * additional destination would dilute the one idea a first-time visitor needs
 * to leave with — that answers here accumulate instead of evaporating.
 */

type Tab = "ask" | "trails";
const SEEN_KEY = "cairn.welcomed.v1";

export default function Home() {
  const [tab, setTab] = useState<Tab>("ask");
  const [replaying, setReplaying] = useState<Trail | null>(null);
  const [welcomed, setWelcomed] = useState(true); // assume seen; corrected on mount
  const { trails, loading, storeKind, refresh } = useTrails();

  // Read on mount rather than during render: localStorage doesn't exist during
  // SSR, and touching it in render would desync hydration.
  useEffect(() => {
    setWelcomed(window.localStorage.getItem(SEEN_KEY) === "1");
  }, []);

  const dismissWelcome = useCallback(() => {
    window.localStorage.setItem(SEEN_KEY, "1");
    setWelcomed(true);
  }, []);

  const handleSaved = useCallback(() => {
    void refresh();
  }, [refresh]);

  const openTrail = useCallback((trail: Trail) => setReplaying(trail), []);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-5 py-6">
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2.5">
          <CairnMark />
          <div>
            <h1 className="text-[15px] font-semibold leading-none tracking-tight text-ink">
              Cairn
            </h1>
            <p className="mt-1 text-[11px] leading-none text-faint">
              Screen-aware help that your team keeps
            </p>
          </div>
        </div>

        <nav className="ml-auto flex rounded-lg border border-line bg-surface p-0.5">
          {(
            [
              ["ask", "Ask"],
              ["trails", `Trails${trails.length ? ` · ${trails.length}` : ""}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                tab === key ? "bg-raised text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1">
        {tab === "ask" ? (
          <AskPanel onTrailSaved={handleSaved} onOpenTrail={openTrail} />
        ) : (
          <TrailLibrary
            trails={trails}
            loading={loading}
            storeKind={storeKind}
            onOpen={openTrail}
          />
        )}
      </main>

      {replaying ? (
        <TrailReplay trail={replaying} onClose={() => setReplaying(null)} />
      ) : null}

      {!welcomed ? <Welcome onDismiss={dismissWelcome} /> : null}
    </div>
  );
}

function CairnMark() {
  // Three stacked stones — the trail marker the product is named for.
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <ellipse cx="12" cy="19" rx="8" ry="2.6" fill="#232733" />
      <ellipse cx="12" cy="15.5" rx="6.4" ry="2.4" fill="#5b6072" />
      <ellipse cx="12" cy="11.6" rx="4.8" ry="2.1" fill="#8b90a3" />
      <ellipse cx="12" cy="8.2" rx="3.2" ry="1.8" fill="#ff8f4c" />
    </svg>
  );
}

/**
 * First-run explainer.
 *
 * Three beats, because the product only makes sense as a sequence: it sees, it
 * points, and — the part that isn't Clicky — it remembers. Dismissed
 * permanently on first read; there is nothing here worth making someone
 * re-read, and a modal that returns is a modal people learn to swat.
 */
function Welcome({ onDismiss }: { onDismiss(): void }) {
  const beats = [
    {
      title: "It sees your screen",
      body: "Share a window and ask out loud. Cairn reads the pixels — no plugins, no integrations, nothing to install.",
    },
    {
      title: "It points at the answer",
      body: "Not a paragraph telling you where the button is. A cursor that lands on it, and a voice that walks you through.",
    },
    {
      title: "It remembers, for everyone",
      body: "Every answer can become a trail. The next teammate who hits that wall gets it instantly — no model call, no waiting.",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/90 p-4 backdrop-blur-sm">
      <div className="animate-rise w-full max-w-lg rounded-2xl border border-line bg-surface p-6">
        <div className="flex items-center gap-2.5">
          <CairnMark />
          <h2 className="text-lg font-semibold tracking-tight text-ink">Cairn</h2>
        </div>
        <p className="mt-2 text-sm text-muted">
          A cairn is the stack of stones one traveller leaves so the next one doesn&apos;t get
          lost.
        </p>

        <ol className="mt-5 space-y-4">
          {beats.map((b, i) => (
            <li key={b.title} className="flex gap-3">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  i === 2 ? "bg-moss text-void" : "bg-raised text-muted"
                }`}
              >
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{b.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">{b.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <button
          onClick={onDismiss}
          className="mt-6 w-full rounded-lg bg-ember py-2.5 text-sm font-medium text-void transition hover:brightness-110"
        >
          Start
        </button>
        <p className="mt-3 text-center text-[11px] text-faint">
          Your screen is only captured at the moment you ask. Frames are never stored unless you
          save a trail.
        </p>
      </div>
    </div>
  );
}
