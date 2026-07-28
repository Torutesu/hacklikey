# Cairn

**Screen-aware help that your team keeps.**

Share a screen, ask out loud, and Cairn points at the answer. Then — the part that isn't Clicky — that answer becomes a **trail** your teammates inherit, so the second person to hit the same wall gets it instantly instead of asking the model again.

> A cairn is the stack of stones one traveller leaves so the next one doesn't get lost.

---

## 概要 (日本語)

Clicky を参考に、**「画面を見て、指し示し、そしてチームのために憶える」** AI アシスタントとして再設計した Web アプリケーションです。

- **見る** — ブラウザの画面共有 API で画面を取得し、Claude の画像認識で読み取ります。インストール不要、URL を開くだけです。
- **指す** — 「右のサイドバーにあります」と文章で説明するのではなく、実際のピクセル上をカーソルが移動し、対象のボタンを囲んで音声で案内します。
- **憶える** — 解決した手順は「トレイル」として保存され、チーム全体の資産になります。次に同じ質問をした人には、**モデルを呼ばずに数ミリ秒で**同じ手順が再生されます。

Clicky は macOS ネイティブですが、本実装は意図的に Web を選びました。「審査担当の方が URL を開くだけで即座に操作できること」を最優先したためです。詳細は [Key decisions](#key-decisions) をご覧ください。

Clicky との最大の違いは **記憶** です。Clicky の支援は 1 対 1 で、答えた瞬間に消えます。Cairn では答えが蓄積され、チームで使うほど速く・安くなります。これが「複数人での利用を想定した構造」と「AI ネイティブな新しい働き方」に対する私なりの回答です。

---

## The product thesis

Clicky's core loop is excellent: hotkey → it sees your screen → you ask out loud → it answers and draws on your screen. I kept that loop.

But that help is **1:1 and ephemeral**. The moment it's given, it evaporates. If five people on a team hit the same wall, the model is asked five times, five people wait, and the company pays five times — for knowledge it already produced on day one.

So Cairn adds one thing, and organises everything else around it:

> **Every answer can become a trail. Recall runs *before* the model, never after.**

The consequences are what make it a different product rather than a feature:

| | Clicky | Cairn |
|---|---|---|
| Second person to ask | Full model call, full wait | Recalled in **~3 ms**, no model call |
| Value over time | Flat | Compounds — the library grows |
| Cost over time | Linear in questions asked | Sub-linear — repeats are free |
| Unit of value | An answer | An asset the team owns |

That is also why the UI colour-codes provenance rather than captioning it: **green means someone already solved this**, amber means it was just read off your screen. It's the one distinction a user needs to internalise, so it gets a colour instead of a sentence.

---

## Main features

**The live half**
- **Screen capture** via `getDisplayMedia()` — any window, tab, or full screen. Nothing is captured until you actually ask.
- **Hold-to-talk** on `Space` (or the button), transcribed with the Web Speech API, with a typed fallback that is always present.
- **Pointed guidance** — the answer is 1–4 steps, each with a normalized bounding box. The UI dims everything else, rings the target, and flies a cursor onto it.
- **Spoken answers** via SpeechSynthesis, step by step.
- **Frame freezing** — when an answer lands, the preview freezes to the exact frame that was sent. The annotation describes *that* moment; leaving live video running would drift the highlight off its target the instant you move a window.

**The memory half**
- **Instant recall** — before any model call, the question is matched against the team's trails. A hit returns in single-digit milliseconds and is visibly labelled as such.
- **Save as trail** — one click promotes a live answer into team memory, with search aliases derived automatically so it's findable by someone who phrases it differently.
- **Replay** — step through the original author's frames with the original annotations, narrated. Not a wiki page describing the sidebar; the sidebar as the person who solved it saw it.
- **Library** — searchable, showing who recorded each trail and how many re-asks it has saved.

---

## Tech

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) + React 19 | One deployable unit for UI and API; the API key never reaches the browser. |
| Language | TypeScript (strict) | The domain is small but the coordinate/provenance handling is fiddly — types carry it. |
| Styling | Tailwind CSS v4 | Design tokens live in `globals.css` as CSS variables; no component library, so the UI has its own character. |
| Vision | Claude (`claude-opus-5`) with structured outputs | Reads UI screenshots and returns pointer geometry, schema-constrained. |
| Capture | `navigator.mediaDevices.getDisplayMedia()` | The web's ScreenCaptureKit. No install. |
| Voice | Web Speech API (in + out) | Zero cost, zero latency, no key. See [Key decisions](#key-decisions). |
| Storage | Pluggable `TrailStore` — in-memory or Upstash Redis | Runs with no infrastructure; becomes genuinely shared with two env vars. |
| Hosting | Vercel | Public URL, free tier. |

No UI kit, no state library, no ORM. At this size they would have been ceremony.

---

## System architecture

```
Browser
  ├─ getDisplayMedia ──► <video> ──► canvas ──► JPEG @1600px ──┐
  ├─ SpeechRecognition ──► question text ─────────────────────┤
  │                                                           ▼
  │                                             POST /api/ask
  │                                                           │
  │                                     ┌─────────────────────┴────────────────┐
  │                                     │ 1. recall(question, trails)          │
  │                                     │    lexical match over the team's     │
  │                                     │    trails — runs FIRST, always       │
  │                                     └────────┬──────────────────┬──────────┘
  │                                         hit  │                  │  miss
  │                                   (~3ms, free)                  │
  │                                              │                  ▼
  │                                              │    2. Claude vision call
  │                                              │       schema-constrained:
  │                                              │       steps[] + targets[]
  │                                     ┌────────┴──────────────────┴──────────┐
  │                                     │       AskResult { source, … }        │
  │◄────────────────────────────────────┴──────────────────────────────────────┘
  │
  ├─ PointerOverlay  → SVG spotlight mask + ring + animated cursor
  ├─ SpeechSynthesis → speaks each step
  └─ "Save as trail" → POST /api/trails → TrailStore
```

**Source layout**

```
src/
  app/
    page.tsx                  App shell, tabs, first-run welcome
    api/ask/route.ts          Recall-then-model. The core decision lives here.
    api/trails/route.ts       List / search / save
    api/trails/[id]/route.ts  Single trail
  components/
    AskPanel.tsx              Live loop: capture, dictate, answer, save
    PointerOverlay.tsx        The "look here" annotation
    TrailLibrary.tsx          Searchable library + useTrails hook
    TrailReplay.tsx           Narrated replay of a saved trail
  lib/
    claude.ts                 The single model call + output schema
    recall.ts                 Question → trail matching
    store.ts                  TrailStore interface + two adapters
    capture.ts                Screen capture, downscaling
    speech.ts                 Voice in/out with graceful degradation
    types.ts, seed.ts
```

The dependency direction is one-way: `components → lib`, and `lib` modules don't import each other except through types. Storage sits behind an interface, so making memory genuinely shared is a deployment concern, not a code change.

---

## Setup

Requires Node 20+.

```bash
git clone https://github.com/Torutesu/hacklikey.git
cd hacklikey
npm install

cp .env.example .env.local     # add ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

**Without an API key it still runs** — the trail library, search, recall, and replay all work, and asking a live question returns a clear "live answers are off" message rather than failing opaquely. That was deliberate: a reviewer should never hit a blank screen.

**Optional — shared team memory.** Unset, trails live in memory and reset when the server sleeps. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (free tier, or the Vercel Upstash integration) and trails become genuinely shared across everyone using the deployment. The UI states which mode it's in rather than leaving it ambiguous.

Use **Chrome or Edge** for the full experience. Screen capture works in desktop Safari; voice *input* is Chromium-only, so every voice affordance has a typed equivalent.

---

## What's implemented

Everything described above is built and working end to end:

- Screen capture, frame grabbing, downscaling, frame freezing
- Voice input (hold-to-talk + `Space`), voice output, typed fallback
- Claude vision call with schema-constrained output and coordinate clamping
- Recall-before-model, with provenance and timing surfaced in the UI
- Save / search / browse / replay trails
- Two storage adapters behind one interface
- First-run onboarding, empty states, error states, `prefers-reduced-motion`
- Graceful degradation for every browser capability it uses

## What's simplified or mocked

Stated plainly, because knowing what I chose *not* to build in two days is part of the answer:

| Area | What I did | Why |
|---|---|---|
| **Auth / identity** | No login. You are a hard-coded "You"; seeded trails have mock authors (Priya, Marco, Yuki). | Auth is well-understood and would have consumed a large share of the time while demonstrating nothing about this product's thesis. The data model already carries `Author`, so real identity is a swap, not a refactor. |
| **Team boundaries** | One global library; no workspaces or permissions. | Same reasoning. The multi-user *structure* is what's being demonstrated; the tenancy boundary is a `WHERE` clause. |
| **Recall matching** | Lexical (token overlap + light stemming), not embeddings. | An embedding round-trip would cost most of the latency recall exists to save, and needs a vector store to justify itself. Documented as the first thing I'd upgrade. |
| **Seeded trail frames** | Schematic wireframes, not real screenshots. | I can't ship screenshots of other companies' UIs. They read honestly as placeholders while still giving replay real geometry. Trails you record yourself carry actual captures. |
| **Agent mode** | Not built. | Clicky's Notion/Gmail/Linear automation is a genuinely different product surface with its own auth and consent design. In two days it would have been a shallow imitation, and it isn't what makes Clicky good. |
| **Hosted TTS** | Browser SpeechSynthesis, not ElevenLabs. | See below. |
| **Tests** | None. | The honest tradeoff for scope at this timescale. `recall.ts` and `capture.ts` are pure and were written to be testable; they're where I'd start. |

---

## Key decisions

**1. Web, not a native app — and why that's a re-design rather than a downgrade.**
Clicky is macOS-native and draws on your real desktop. A browser cannot do that; it can only annotate inside its own page. I chose the web anyway, because the binding constraint on this assignment is *"the company must be able to actually operate it"* — a URL beats an unsigned binary, works on every OS, and needs no install. I then leaned into what the browser makes *better*: because Cairn annotates a mirrored frame rather than a live desktop, that annotated frame is inherently shareable and replayable — which is exactly what team memory needs. The limitation and the feature turn out to be the same fact.

**2. Recall runs before the model, not as a cache after it.**
A cache keyed on inputs would only hit on an identical question. Recall matches *intent* against what the team has already solved, and it is the first thing `/api/ask` does. This ordering is the product: it's why the second person doesn't wait.

**3. Lexical recall, tuned to prefer a model call over a wrong trail.**
The threshold is set high on purpose. Showing someone a confidently irrelevant walkthrough is far more damaging to trust than making them wait three seconds. Asymmetric costs deserve asymmetric thresholds.

**4. Structured outputs instead of parsing prose.**
Pointer coordinates come back through a JSON schema, so geometry is structurally guaranteed and the UI never has to defend against a malformed answer. Coordinates are normalized 0–1, so the client can downscale frames for bandwidth without annotations drifting.

**5. Low effort, thinking left on.**
This is a latency-critical single-screenshot reading task with a user waiting. Effort is pinned to `low`. Thinking is deliberately *not* disabled — on this model disabling it can leak reasoning into the visible answer, and low effort already recovers the latency.

**6. Browser speech over hosted TTS.**
Clicky uses ElevenLabs. For short imperative instructions, hosted voice quality doesn't change whether the instruction lands, but the network round-trip is very noticeable — and it adds a key to manage and a per-word cost. Free, instant, and local was the better trade. It's one function to swap.

**7. Storage behind an interface, defaulting to zero-config.**
The app must run for a reviewer who clones it with no accounts, *and* demonstrate genuinely shared memory. Two adapters behind one interface gets both, and the UI is honest about which mode it's in.

**8. One dark theme, two accent colours, no component library.**
Cairn sits beside the app you're actually working in, so it stays visually subordinate rather than competing. Ember and moss are used for exactly one thing — live answer vs. recalled answer — so colour carries the core idea instead of decoration.

---

## What I'd do next

Roughly in the order I'd actually pick them up:

1. **Real identity and workspaces.** The highest-value gap. Everything is shaped for it; nothing is wired to it.
2. **Hybrid recall.** Keep the lexical pass as the instant path, add embeddings as a second pass on miss. Semantically related questions ("resolution too low on export") would then find the 3x trail.
3. **Trails that decay.** Software UIs change. A trail whose frames no longer match the live screen should be flagged as stale — detectable by comparing a fresh capture against the stored frame, and the single biggest long-term risk to trusting the library.
4. **Streamed answers.** Speak step one while the rest is still generating, to cut perceived latency roughly in half.
5. **Multi-frame trails.** Today a trail's steps share one capture. Recording across several screens would let a trail span a genuine multi-screen flow.
6. **Tests** around `recall.ts` (threshold regressions are silent and expensive) and the coordinate clamping.
7. **A real hotkey.** `Space` only works while the tab is focused. A browser extension or a thin desktop shell would restore Clicky's "works while you're in the other app" property, which is the one thing the web genuinely costs.

---

## Third-party code and assets

| Item | Source | Licence |
|---|---|---|
| Next.js, React, Tailwind CSS | npm, unmodified | MIT |
| `@anthropic-ai/sdk` | npm, unmodified | MIT |
| Geist / Geist Mono fonts | Bundled via `next/font` | SIL Open Font License 1.1 |
| Everything in `src/` | Written for this assignment | — |

No code was reused from prior personal projects, and no assets, screenshots, code, or design data were taken from Clicky or any other third party. The wireframe frames in `src/lib/seed.ts` are generated SVG written for this repository. Icons and the Cairn mark are hand-written inline SVG.

Developed with AI coding assistance, which the assignment expressly permits.
