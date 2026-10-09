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

**Find your pace** is a fictional 12-minute session: a warm-up, eight work/recovery slots alternating Tempo squat and Standing reach, and a cool-down. The coach checks in after the warm-up and after each recovery, and the rest of the plan changes when you ask it to.

The main decision was to keep the model away from workout state. `src/shared/workout/session.ts` owns the plan as plain functions (start, finish, end, ease, shorten), and `openui-bridge.ts` renders every screen from it. The model reads the session and replies with a sentence or two, plus at most one `Proposal("ease")`, `Proposal("shorten", seconds)` or `Proposal("keep")`. The browser checks the proposal and applies it, unless another change or a restart happened while the model was replying. Buttons on screen skip the model and apply directly.

Adaptations never rewrite what has already happened. Easing changes only slots that haven't started, from 40s/20s to 25s/35s. Shortening drops whole untouched slots from the end, then trims the cool-down (not below 30s); it never touches the running interval, and if the target can't be met it changes nothing and says why.

Out of scope on purpose: anything medical. The coach treats pain or injury as a reason to pause or stop, and only talks about the simulation.

The recap is computed from session state, and **Download run JSON** under Builder tools exports the full action history. `evidence/screenshots/` has screenshots from the browser tests and from the live Claude run.

### 90-second reviewer walkthrough
1. Click **Start demo session**, then **Start opening**, then **Simulate interval finish** to reach the first check-in.
2. Click **Continue next slot** and **Simulate interval finish**: the work slot ends and its recovery starts automatically; finishing that returns to a check-in.
3. Click **Make it easier** on the check-in screen: upcoming slots change from 40s/20s to 25s/35s.
4. Type `I only have 4 minutes left` and press Enter: the coach replies with a Proposal and the remaining plan is trimmed to fit 240 seconds. (`shorten it` alone gets a follow-up question.)
5. Keep clicking through, or use **Skip ahead to recap** to fast-forward the remaining intervals.
6. Open **Builder tools** and click **Download run JSON** to export the run.

## Runtime modes tested

| Mode | Status |
| --- | --- |
| **Mock** | Tested: `npm run check` (typecheck, lint, 59 unit tests) and `npm run test:ui` (13 Playwright tests, run with Google Chrome 154 via `PLAYWRIGHT_CHROME_PATH`), plus a manual click-through in the browser. Node 26.7 on macOS. |
| **ClaudeCLI** | **Tested live** on 9 October 2026: Claude Code 2.1.278 with a Claude-plan login; the CLI reported `claude-sonnet-5`. One scripted 8-turn session: "too intense" → `Proposal("ease")`, applied; "shorten it" → asked how much time was left; "I only have 4 minutes left" → `Proposal("shorten", 240)`, applied; "my knee hurts" → the simulation/safety boundary and a suggestion to pause or end. Both adaptations are recorded with `source: "model"`. The export is in `runs/claude-cli-live.json` and a screenshot in `evidence/screenshots/06-live-claude.png`. The consent flow is also covered by the browser tests with a faked response. |
| **OpenAIAPI** | Adapter unit tests with fake transports only. No live request. |
| **CodexCLI** | Disabled by the starter; not tested. |

Mock is deterministic. It mirrors the skill's Proposal protocol for the requests listed above, but it does not read `skills/workout.md`. The live Claude check is one session, not a broad evaluation of model behaviour.

## Project layout

- `skills/workout.md`: the coach's instructions and the Proposal contract.
- `src/shared/workout/`: session state, adaptations and screen rendering for the workout.
- `prompts/`: output protocol and current-turn context.
- `runs/claude-cli-live.json`: the exported live Claude run.
- `evidence/screenshots/`: screenshots captured by the browser tests and the live run.
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
