"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PointerOverlay } from "./PointerOverlay";
import {
  CaptureUnsupportedError,
  grabFrame,
  isCaptureSupported,
  shrinkForStorage,
  startCapture,
  type Frame,
} from "@/lib/capture";
import {
  isVoiceInputSupported,
  speak,
  startDictation,
  stopSpeaking,
} from "@/lib/speech";
import type { AskResult, Step, Trail } from "@/lib/types";

/**
 * The live half of Cairn: share a screen, ask out loud, get pointed at the answer.
 *
 * Two behaviours here are load-bearing and easy to break:
 *
 *  - When an answer arrives the preview *freezes* to the exact frame that was
 *    sent to the model. The annotation describes that moment; leaving the live
 *    video running underneath would drift the highlight off its target the
 *    instant the user moves a window.
 *
 *  - Recalled trails render their original author's frames, not yours. Seeing
 *    the screen the way the person who solved it saw it is what makes a trail
 *    feel like being shown, rather than being told.
 */

type Phase = "idle" | "listening" | "thinking" | "answered" | "error";

interface AskPanelProps {
  onTrailSaved(trail: Trail): void;
  onOpenTrail(trail: Trail): void;
}

export function AskPanel({ onTrailSaved, onOpenTrail }: AskPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [sharing, setSharing] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [question, setQuestion] = useState("");
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [frozen, setFrozen] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"none" | "saving" | "saved">("none");

  const stopDictationRef = useRef<(() => void) | null>(null);
  const voiceIn = isVoiceInputSupported();

  /* ---------------------------------------------------------------- capture */

  const stopSharing = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setSharing(false);
  }, []);

  const beginSharing = useCallback(async () => {
    setError(null);
    try {
      const stream = await startCapture();
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      // The browser's own "Stop sharing" bar bypasses our UI entirely, so we
      // have to listen for it or the panel would claim to still be sharing.
      stream.getVideoTracks()[0]?.addEventListener("ended", stopSharing);
      setSharing(true);
    } catch (err) {
      if (err instanceof CaptureUnsupportedError) setError(err.message);
      else setError("Screen sharing was dismissed. Nothing was captured.");
    }
  }, [stopSharing]);

  useEffect(() => () => stopSharing(), [stopSharing]);

  /* ------------------------------------------------------------------- ask */

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q) return;

      stopSpeaking();
      setQuestion(q);
      setPhase("thinking");
      setError(null);
      setResult(null);
      setStepIndex(0);
      setSaveState("none");

      // Capture before the network call so the frame matches the question's
      // moment, not whatever is on screen when the response lands.
      let frame: Frame | null = null;
      if (sharing && videoRef.current) {
        try {
          frame = grabFrame(videoRef.current);
          setFrozen(frame);
        } catch {
          /* fall through — recall may still answer without a frame */
        }
      }

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: q,
            frame: frame?.base64,
            mediaType: frame?.mediaType,
          }),
        });
        const data = (await res.json()) as AskResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Cairn couldn't answer that.");

        // Live answers carry no frames back (the client already has one), so
        // attach the capture here for display and for saving.
        const steps: Step[] =
          data.source === "model"
            ? data.steps.map((s) => ({ ...s, frame: frame?.dataUrl ?? null }))
            : data.steps;

        setResult({ ...data, steps });
        setPhase("answered");
        speak(`${data.summary} ${steps[0]?.say ?? ""}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setPhase("error");
      }
    },
    [sharing],
  );

  /* ------------------------------------------------------------------ voice */

  const beginListening = useCallback(() => {
    if (!voiceIn || phase === "listening") return;
    stopSpeaking();
    setPhase("listening");
    setQuestion("");
    stopDictationRef.current = startDictation({
      onPartial: setQuestion,
      onFinal: (text) => {
        setPhase("idle");
        void ask(text);
      },
      onError: (message) => {
        setError(message);
        setPhase("idle");
      },
    });
  }, [ask, phase, voiceIn]);

  const endListening = useCallback(() => {
    stopDictationRef.current?.();
    stopDictationRef.current = null;
  }, []);

  // Hold-to-talk. Space is the whole interaction, so it must not fire while
  // the user is typing into the fallback input or any other field.
  useEffect(() => {
    if (!voiceIn) return;
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping(e.target)) return;
      e.preventDefault();
      beginListening();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      endListening();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [beginListening, endListening, voiceIn]);

  /* ------------------------------------------------------------------ steps */

  const steps = result?.steps ?? [];
  const step = steps[stepIndex] ?? null;

  const goToStep = useCallback(
    (i: number) => {
      if (i < 0 || i >= steps.length) return;
      setStepIndex(i);
      speak(steps[i].say);
    },
    [steps],
  );

  /* ------------------------------------------------------------------- save */

  const saveTrail = useCallback(async () => {
    if (!result || result.source !== "model") return;
    setSaveState("saving");
    try {
      // Shrink frames before they go into storage — see capture.ts.
      const stored = await Promise.all(
        result.steps.map(async (s) => ({
          ...s,
          frame: s.frame ? await shrinkForStorage(s.frame) : null,
        })),
      );
      const res = await fetch("/api/trails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.title,
          question,
          app: result.app,
          steps: stored,
        }),
      });
      const data = (await res.json()) as { trail?: Trail; error?: string };
      if (!res.ok || !data.trail) throw new Error(data.error ?? "Couldn't save.");
      setSaveState("saved");
      onTrailSaved(data.trail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that trail.");
      setSaveState("none");
    }
  }, [onTrailSaved, question, result]);

  /* -------------------------------------------------------------- rendering */

  const tone = result?.source === "trail" ? "moss" : "ember";
  // Recalled trails show the author's frame; live answers show your capture.
  const displayFrame = step?.frame ?? frozen?.dataUrl ?? null;
  const showFrozen = phase === "answered" && displayFrame;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]">
      {/* ------------------------------------------------------------ stage */}
      <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-surface">
        <video
          ref={videoRef}
          muted
          playsInline
          className={`h-full w-full object-contain ${showFrozen ? "invisible" : ""}`}
        />

        {showFrozen ? (
          <img
            src={displayFrame}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
          />
        ) : null}

        {phase === "answered" && step ? (
          <PointerOverlay
            target={step.target}
            label={step.label}
            tone={tone}
            stepKey={`${stepIndex}-${result?.title ?? ""}`}
          />
        ) : null}

        {!sharing && phase !== "answered" ? <ShareInvite onShare={beginSharing} /> : null}

        {phase === "thinking" ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-gradient-to-t from-void/95 to-transparent px-4 pb-4 pt-10 text-sm text-muted">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-ember" />
            Reading your screen…
          </div>
        ) : null}

        {sharing && phase !== "answered" ? (
          <button
            onClick={stopSharing}
            className="absolute right-3 top-3 rounded-full border border-line bg-void/80 px-2.5 py-1 text-[11px] text-muted backdrop-blur transition hover:text-ink"
          >
            Stop sharing
          </button>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- side rail */}
      <div className="flex flex-col gap-4">
        <AskBar
          phase={phase}
          question={question}
          typed={typed}
          voiceIn={voiceIn}
          onTypedChange={setTyped}
          onSubmitTyped={() => {
            const t = typed;
            setTyped("");
            void ask(t);
          }}
          onPressStart={beginListening}
          onPressEnd={endListening}
        />

        {error ? (
          <p className="animate-rise rounded-lg border border-ember-dim bg-ember-dim/20 px-3 py-2.5 text-sm text-ember">
            {error}
          </p>
        ) : null}

        {phase === "thinking" ? <AnswerSkeleton /> : null}

        {phase === "answered" && result ? (
          <AnswerCard
            result={result}
            stepIndex={stepIndex}
            onStep={goToStep}
            onReplayTrail={() => result.trail && onOpenTrail(result.trail)}
            onSave={saveTrail}
            saveState={saveState}
          />
        ) : null}

        {phase === "idle" && !result ? <Hints capture={isCaptureSupported()} voice={voiceIn} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function ShareInvite({ onShare }: { onShare(): void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex flex-col items-center gap-1.5" aria-hidden>
        <span className="h-1.5 w-7 rounded-full bg-faint/70" />
        <span className="h-1.5 w-11 rounded-full bg-faint/50" />
        <span className="h-1.5 w-14 rounded-full bg-faint/30" />
      </div>
      <div>
        <p className="text-sm text-ink">Cairn needs to see what you see.</p>
        <p className="mt-1 text-xs text-faint">
          Nothing is captured until you ask a question.
        </p>
      </div>
      <button
        onClick={onShare}
        className="rounded-full bg-ember px-4 py-2 text-sm font-medium text-void transition hover:brightness-110"
      >
        Share a screen
      </button>
    </div>
  );
}

interface AskBarProps {
  phase: Phase;
  question: string;
  typed: string;
  voiceIn: boolean;
  onTypedChange(v: string): void;
  onSubmitTyped(): void;
  onPressStart(): void;
  onPressEnd(): void;
}

function AskBar({
  phase,
  question,
  typed,
  voiceIn,
  onTypedChange,
  onSubmitTyped,
  onPressStart,
  onPressEnd,
}: AskBarProps) {
  const listening = phase === "listening";
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      {voiceIn ? (
        <>
          <button
            onMouseDown={onPressStart}
            onMouseUp={onPressEnd}
            onMouseLeave={onPressEnd}
            onTouchStart={onPressStart}
            onTouchEnd={onPressEnd}
            className={`flex w-full items-center justify-center gap-2.5 rounded-lg py-3 text-sm font-medium transition ${
              listening
                ? "bg-ember text-void"
                : "bg-raised text-ink hover:bg-line"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${listening ? "animate-ping bg-void" : "bg-ember"}`}
            />
            {listening ? "Listening…" : "Hold to ask"}
          </button>
          <p className="mt-2 text-center text-[11px] text-faint">
            or hold <kbd className="rounded border border-line px-1">Space</kbd>
          </p>
          {listening && question ? (
            <p className="mt-2 text-center text-sm text-muted">{question}</p>
          ) : null}
          <div className="my-3 h-px bg-line" />
        </>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmitTyped();
        }}
        className="flex gap-2"
      >
        <input
          value={typed}
          onChange={(e) => onTypedChange(e.target.value)}
          placeholder={voiceIn ? "or type a question" : "Ask about your screen"}
          className="min-w-0 flex-1 rounded-lg border border-line bg-void px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-faint"
        />
        <button
          type="submit"
          disabled={!typed.trim()}
          className="rounded-lg bg-raised px-3 py-2 text-sm text-ink transition enabled:hover:bg-line disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

function AnswerSkeleton() {
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface p-4">
      <div className="shimmer h-3 w-2/3 rounded" />
      <div className="shimmer h-3 w-full rounded" />
      <div className="shimmer h-3 w-4/5 rounded" />
    </div>
  );
}

interface AnswerCardProps {
  result: AskResult;
  stepIndex: number;
  onStep(i: number): void;
  onReplayTrail(): void;
  onSave(): void;
  saveState: "none" | "saving" | "saved";
}

function AnswerCard({
  result,
  stepIndex,
  onStep,
  onReplayTrail,
  onSave,
  saveState,
}: AnswerCardProps) {
  const fromMemory = result.source === "trail";
  return (
    <div className="animate-rise rounded-xl border border-line bg-surface p-4">
      {/* Provenance banner. The speed number is the argument, so it's shown. */}
      <div
        className={`mb-3 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
          fromMemory
            ? "bg-moss-dim/40 text-moss"
            : "bg-ember-dim/30 text-ember"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${fromMemory ? "bg-moss" : "bg-ember"}`} />
        {fromMemory ? "From team memory" : "Read live from your screen"}
        <span className="ml-auto font-mono text-faint">{result.elapsedMs}ms</span>
      </div>

      <p className="text-sm text-ink">{result.summary}</p>

      <ol className="mt-3 space-y-1">
        {result.steps.map((s, i) => (
          <li key={s.id}>
            <button
              onClick={() => onStep(i)}
              className={`flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                i === stepIndex ? "bg-raised text-ink" : "text-muted hover:bg-raised/60"
              }`}
            >
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  i === stepIndex
                    ? fromMemory
                      ? "bg-moss text-void"
                      : "bg-ember text-void"
                    : "bg-line text-faint"
                }`}
              >
                {i + 1}
              </span>
              {s.say}
            </button>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <button
          onClick={() => onStep(stepIndex - 1)}
          disabled={stepIndex === 0}
          className="rounded-lg bg-raised px-2.5 py-1.5 text-xs text-ink transition enabled:hover:bg-line disabled:opacity-30"
        >
          Back
        </button>
        <button
          onClick={() => onStep(stepIndex + 1)}
          disabled={stepIndex >= result.steps.length - 1}
          className="rounded-lg bg-raised px-2.5 py-1.5 text-xs text-ink transition enabled:hover:bg-line disabled:opacity-30"
        >
          Next
        </button>

        <div className="ml-auto">
          {fromMemory ? (
            <button
              onClick={onReplayTrail}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-moss transition hover:bg-moss-dim/30"
            >
              Open trail →
            </button>
          ) : saveState === "saved" ? (
            <span className="text-xs text-moss">Saved for the team ✓</span>
          ) : (
            <button
              onClick={onSave}
              disabled={saveState === "saving"}
              className="rounded-lg bg-ember px-2.5 py-1.5 text-xs font-medium text-void transition hover:brightness-110 disabled:opacity-50"
            >
              {saveState === "saving" ? "Saving…" : "Save as trail"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Hints({ capture, voice }: { capture: boolean; voice: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-sm">
      <p className="text-muted">Try asking:</p>
      <ul className="mt-2 space-y-1.5 text-ink">
        <li>“What does this error mean?”</li>
        <li>“Where do I change the billing address?”</li>
        <li>“How do I export this at 3x?”</li>
      </ul>
      {!capture || !voice ? (
        <p className="mt-3 border-t border-line pt-3 text-xs text-faint">
          {!capture
            ? "Screen sharing isn't available in this browser — Chrome, Edge, or desktop Safari work."
            : "Voice input isn't available in this browser, so use the text box."}
        </p>
      ) : null}
    </div>
  );
}
