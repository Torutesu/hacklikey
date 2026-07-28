# Cairn

*[日本語版はこちら](./README.md)*

Share your screen, ask a question out loud, and Cairn points at the answer on screen and talks you through it.

Then it keeps the answer. Anything Cairn works out for you can be saved as a "trail", and the next person on your team who asks the same thing gets that trail back instantly instead of waiting on the model again.

The name comes from the piles of stones hikers leave to mark a path for whoever comes next.

Live demo: _(deploying — URL will go here)_

## Why I built it this way

Clicky's core experience works well. Press a hotkey, let it see your screen, ask out loud, get pointed at the thing. I kept that loop as-is.

The problem is that the help is one-off. The moment it's given, it's gone. If five people on a team hit the same wall, you pay for five model calls and five people wait, for something the model already worked out on day one.

So I added one thing. **Answers can be saved as trails, and any incoming question searches the trails before it ever reaches the model.** The order matters; put the search after the model and it's just a cache.

What that changes:

|  | Clicky | Cairn |
|---|---|---|
| Second person asks the same thing | Full model call every time | ~3ms, no model call |
| Value as you keep using it | Flat | Accumulates |
| Cost | Scales with questions asked | Repeats are free |

It's also why the UI uses colour the way it does. Green means someone already solved this, orange means it was just read off your screen. That's the one distinction a user needs to hold onto, so it gets a colour instead of a sentence of explanation.

## What it does

Share a screen and ask, and you get back one to four steps. Each step carries coordinates for what to point at, so the UI dims the surroundings, rings the target, and flies a cursor onto it. It reads the steps aloud as it goes.

Voice input is hold-Space (or hold the button). Typing works everywhere too. Some browsers, Firefox among them, have no speech recognition at all, so voice is the fast path rather than the only path.

The moment an answer lands, the preview freezes to the exact image that was sent to the model. Without that, the highlight drifts off the real button as soon as you move a window.

Saving is one button under the answer. Search aliases are generated from the question and the title, so someone who phrases it differently still finds it. The library is searchable and shows who wrote each trail and how many times it's been reused. Opening a trail replays it with the original author's screen and annotations, narrated.

## Tech

| | |
|---|---|
| Next.js 16 (App Router) + React 19 | UI and API deploy as one thing, and the API key never reaches the browser |
| TypeScript | The coordinate handling is fiddlier than it looks, so types carry it |
| Tailwind CSS v4 | Design tokens live in `globals.css` as CSS variables |
| Claude (`claude-opus-5`) | Reads the screen. Structured outputs so it returns real coordinates |
| `getDisplayMedia()` | Screen capture |
| Web Speech API | Voice in and out |
| Upstash Redis (optional) | Shared storage for trails |
| Vercel | Hosting |

No UI library, no state management library, no ORM. At this size they'd cost more to manage than they'd save.

## How it fits together

Here's what happens when a question comes in. This is the centre of the design.

```
Browser
  getDisplayMedia → <video> → canvas → JPEG (1600px long edge)
  SpeechRecognition → question text
        ↓
  POST /api/ask
        ↓
  1. recall(question, all trails)   ← always runs first
        ├─ hit  → ~3ms, no model call
        └─ miss → 2. send image + question to Claude
                     structured outputs: steps[] with coordinates
        ↓
  AskResult { source: "trail" | "model", steps, ... }
        ↓
  PointerOverlay (SVG mask dims around the target, plus the cursor)
  SpeechSynthesis (narration)
  "Save as trail" → POST /api/trails → TrailStore
```

File layout:

```
src/
  app/
    page.tsx                  Shell, tabs, first-run explainer
    api/ask/route.ts          recall then model. The core decision lives here
    api/trails/route.ts       List / search / save
    api/trails/[id]/route.ts  Single trail
  components/
    AskPanel.tsx              Capture, voice, answer, save
    PointerOverlay.tsx        The on-screen pointing
    TrailLibrary.tsx          Library and useTrails
    TrailReplay.tsx           Trail playback
  lib/
    claude.ts                 Model call and output schema
    recall.ts                 Question to trail matching
    store.ts                  TrailStore and its two adapters
    capture.ts                Capture and downscaling
    speech.ts                 Voice in and out
    types.ts, seed.ts
```

Dependencies run one way, `components → lib`, and the `lib` modules don't reference each other except through types. Storage sits behind an interface, so switching to shared storage is an environment variable rather than a code change.

## Setup

Needs Node 20 or newer.

```bash
git clone https://github.com/Torutesu/hacklikey.git
cd hacklikey
npm install

cp .env.example .env.local     # add ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

It runs without an API key. The trail list, search, recall and replay all work, and only live questions show a "not available right now" message. I did that so whoever reviews this doesn't land on a blank screen.

To actually share trails, set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Unset, trails are held in memory and disappear when the server sleeps. The UI says which mode it's in.

Chrome or Edge recommended. Screen sharing works in Safari, but speech recognition is Chromium-only.

## What's built

Everything above works. Screen capture, frame freezing, voice in and out plus typing, the Claude call with coordinate clamping, recall with its source and timing shown in the UI, saving / searching / replaying trails, both storage adapters, the first-run explainer, empty and error states, and `prefers-reduced-motion`.

## What I simplified

Deciding what not to build in two days is part of the answer, so here it is honestly.

**Auth and users.** No login. You're hardcoded as "You", and the seeded trail authors (Priya, Marco, Yuki) are mocks. Auth is well-understood, eats a lot of time, and proves nothing about this product's argument. The data model already carries `Author`, so it's a swap rather than a rebuild.

**Team boundaries.** No workspaces or permissions, one shared library. Same reasoning: what I wanted to show is the structure for multiple people using it.

**Recall matching.** Word overlap with light stemming, no embeddings. Embeddings add a round trip that eats most of the latency recall exists to save, and need a vector store. This is the first thing I'd upgrade.

**Seeded trail images.** Generated wireframes, not real screenshots. I can't ship screenshots of other companies' UIs. They read clearly as placeholders while still giving replay real geometry to annotate. Trails you record yourself contain actual captures.

**Agent mode.** Not built. Clicky's Notion / Gmail / Linear integration is effectively a second product with its own auth and consent design. In two days it would have been a shallow imitation, and it isn't the part of Clicky that makes Clicky good.

**Text to speech.** Browser SpeechSynthesis rather than ElevenLabs. Reasoning below.

**Tests.** None. That's the honest tradeoff at this timescale. `recall.ts` and `capture.ts` are side-effect free and written to be testable, so that's where I'd start.

## Decisions I made

**Going with the web.** Clicky is macOS-native and draws on your actual desktop. A browser can't do that; it can only touch its own page. I chose the web anyway because the constraint that matters most here is that someone else can actually operate the thing. A URL works on any OS with no install and no code signing.

Then I leaned into where the browser is actually better. Because Cairn annotates a mirrored frame rather than the live desktop, that annotated frame is shareable and replayable as-is, which is exactly what team memory needs. The limitation and the feature turned out to be the same fact.

**Recall goes in front of the model.** Behind it, it's a cache that only fires on an exact repeat. In front, it's asking whether the team has already solved this. It's the first thing `/api/ask` does.

**The recall threshold is deliberately high.** When in doubt it calls the model. Confidently showing someone an irrelevant walkthrough damages trust far more than making them wait three seconds. The costs are asymmetric, so the threshold is too.

**Output comes back as schema, not prose.** Coordinates arrive through a JSON schema, so the UI never has to guard against a malformed answer. They're normalized 0 to 1, so downscaling the image for bandwidth doesn't shift the annotation.

**Low effort, thinking left on.** Someone is sitting there with their screen shared while a single screenshot gets read, so effort is pinned low. I left thinking on deliberately: turning it off on this model can leak reasoning into the answer, and low effort already recovers the speed.

**The built-in voice was good enough.** Clicky uses ElevenLabs. For short imperative instructions, voice quality barely affects whether the instruction lands, but the network round trip is obvious. Free, instant, and no key to manage won. It's one function to swap if that changes.

**Storage behind an interface, zero-config by default.** Someone cloning this with no accounts should get a working app, and I also wanted to show memory that's genuinely shared. Two adapters cover both, and the UI is honest about which one is running.

**One dark theme, two accent colours.** Cairn sits next to whatever you're actually working in, so it shouldn't compete for attention. Orange and green are used only to distinguish a live answer from a recalled one. I wanted colour carrying meaning rather than decoration.

## What I'd do next

Roughly the order I'd pick them up.

1. Auth and workspaces. The biggest gap. The shape is there, it just isn't wired up.
2. Hybrid recall. Keep the fast word matching, add an embedding second pass only on a miss, so "the exported image isn't high enough resolution" still finds the 3x trail.
3. Staleness. UIs change, so a trail whose stored frames no longer match the live screen should get flagged as old. Long term I think this decides whether the library stays trustworthy.
4. Streaming. Start narrating step one while the rest generates, roughly halving perceived wait.
5. Multi-frame trails. Right now one trail shares one capture. I'd like to record flows that cross several screens.
6. Tests for `recall.ts`. Threshold regressions fail silently and hurt.
7. A real hotkey. Space only works while the tab has focus. An extension or a thin desktop shell would bring back Clicky's "works while you're inside another app" property. That's the one thing choosing the web actually costs.

## Third-party code and assets

| Item | Source | Licence |
|---|---|---|
| Next.js, React, Tailwind CSS | npm, unmodified | MIT |
| `@anthropic-ai/sdk` | npm, unmodified | MIT |
| Geist / Geist Mono | via `next/font` | SIL OFL 1.1 |
| Everything under `src/` | Written for this assignment | — |

No code was carried over from my own earlier projects. No third-party code, images, text or design data was used, including from Clicky. The wireframes in `src/lib/seed.ts` are SVG written for this repository, and the icons are hand-written inline SVG.
