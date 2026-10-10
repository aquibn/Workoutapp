# AiRA · Find your pace

An AI-guided, fictional adaptive workout built on the AiRA workout starter, a local browser harness derived from AiRA API and AiRA client code. The assignment is in [docs/EXERCISE.md](docs/EXERCISE.md).

## Run

Requires Node.js 22.18 or later and npm. From this directory:

```sh
npm ci --ignore-scripts
npm start
```

Open http://127.0.0.1:4319. Stop with Ctrl+C. Change `PORT` in a local `.env` if needed.

The app starts in Mock and needs no account or key. Click **Start demo session** to begin the fictional 12-minute pace-finding workout. The starter's generic wiring sample is still available under **Builder tools → Developer checks**.

## What I built

**Find your pace** is a fictional 12-minute session: a warm-up, eight work/recovery slots alternating Tempo squat and Standing reach, and a cool-down. A strip across the top of the session shows every interval, so you can see the plan change as it adapts.

The main decision was to keep the model away from workout state. `src/shared/workout/session.ts` owns the plan as plain functions, and `openui-bridge.ts` renders every screen from it. The model reads the session and replies with a sentence or two plus, at most, one structured change. There are two kinds, and the difference matters:

- **`Proposal`** answers something you typed ("this is too intense", "I have 4 minutes left"). The browser checks it against the session revision the request was based on and applies it if nothing has moved on since.
- **`Suggest`** is the coach taking the initiative. After each recovery you can rate the slot from 1 (very easy) to 5 (very hard). The coach looks at your ratings so far and may suggest easing or pushing, which appears as an offer you can apply or dismiss. A suggestion never changes the plan by itself.

Buttons on screen apply their change locally, whatever the provider's state. If a provider is ready, the coach is then told about the press so it can comment, and a comment on a button press can never change the plan. Typed text never runs a command.

Adaptations never rewrite what has already happened. Easing and pushing move untouched slots one pace level (gentle 25s/35s, steady 40s/20s, strong 50s/10s); every level keeps a slot at 60 seconds. Shortening drops whole untouched slots from the end, then trims the cool-down (not below 30s); it never touches the running interval, and if the target can't be met it changes nothing and says why.

Out of scope on purpose: anything medical. The coach treats pain or injury as a reason to pause or stop, and only talks about the simulation.

Once a session starts, the intro and settings collapse so the session leads, on a phone too. The recap is computed from session state, including your effort ratings, and **Download run JSON** under Builder tools exports the full action history.

### 90-second reviewer walkthrough
1. Click **Start demo session**, then **Start opening**, then the timer's **Simulate finish** to reach the first check-in.
2. Click **Continue next slot**, then **Simulate finish**: the work slot ends and its recovery starts automatically; finishing that returns to a check-in.
3. Click **Continue next slot**, finish the work slot and its recovery, then rate it **Effort 5 · very hard**: the coach suggests more recovery. Choose **Apply suggestion** or **Not now**.
4. Try **Make it harder** or **Make it easier**, or type `I only have 4 minutes left`: the coach replies with a Proposal and the remaining plan is trimmed to fit. (`shorten it` alone gets a follow-up question.)
5. Keep clicking through, or use **Skip ahead to recap** to fast-forward the remaining intervals.
6. Open **Builder tools** and click **Download run JSON** to export the run.

## Runtime modes tested

| Mode | Status |
| --- | --- |
| **Mock** | Tested: `npm run check` (typecheck, lint, 71 unit tests) and `npm run test:ui` (28 Playwright tests, run with Google Chrome 154 via `PLAYWRIGHT_CHROME_PATH`), plus a manual click-through in the browser. Node 26.7 on macOS. |
| **ClaudeCLI** | **Tested live** on 9 October 2026: Claude Code 2.1.278 with a Claude-plan login; the CLI reported `claude-sonnet-5`. One scripted 8-turn session: "too intense" → `Proposal("ease")`, applied; "shorten it" → asked how much time was left; "I only have 4 minutes left" → `Proposal("shorten", 240)`, applied; "my knee hurts" → the simulation/safety boundary and a suggestion to pause or end. Both adaptations are recorded with `source: "model"`. The export is in `runs/claude-cli-live.json` and a screenshot in `evidence/screenshots/06-live-claude.png`. The consent flow is also covered by the browser tests with a faked response. The run was recorded on an earlier version. Since then the skill has gained effort check-ins, `Suggest` and "harder", and the component catalog sent to the model has changed, so this run does not cover those parts; a fresh live run is still to do. |
| **OpenAIAPI** | Adapter unit tests with fake transports only. No live request. |
| **CodexCLI** | Disabled by the starter; not tested. |

Mock is deterministic. It mirrors the skill's Proposal protocol for the requests listed above, but it does not read `skills/workout.md`. The live Claude check is one session, not a broad evaluation of model behaviour.

## Project layout

- `skills/workout.md`: the coach's instructions and the Proposal contract.
- `src/shared/workout/`: session state, adaptations and screen rendering for the workout.
- `prompts/`: output protocol and current-turn context.
- `runs/claude-cli-live.json`: the exported live Claude run.
- `evidence/screenshots/`: screenshots from the browser tests and the live run. Tests leave them alone unless you run `CAPTURE_EVIDENCE=1 npm run test:ui`.
- `src/shared/openui/`: parser, component registry, validation, navigation, timers and serialization.
- `src/web/`: browser renderers and presentation.
- `src/server/`: prompt loading, local HTTP server, mock and model adapters.
- `examples/wiring.openui`: generic offline fixture.

See [AiRA harness](docs/HARNESS.md) for the included plumbing and [runtime setup](docs/RUNTIMES.md) for optional model adapters.

## Check and package

```sh
npm run check
npx playwright install chromium
npm run test:ui
npm run package
```

The browser checks start a mock server on port 4320. To use an installed Chrome instead, set `PLAYWRIGHT_CHROME_PATH` to its absolute executable path.

Packaging writes `output/workout-source.zip` locally. It includes source and records changes against this starter's baseline; it excludes `.env`, dependencies, build output and repository history. It does not submit anything. Builder tools can export a local run; optional run JSON files can be placed in `runs/`. Keep credentials out of source and exports.

The tests exercise local harness behavior with fake transports; see *Runtime modes tested* above. This browser slice is not the production AiRA application.
