# Controls latency on the `next` fork

The diagnostic story and browser runner reproduce [Penner #3073](https://github.com/robertpenner/penner/issues/3073) against `robertpenner/storybook` at `6643f314a1ebf29a2736536970b49e53d92bdd87`. This is the unmodified fork runtime. The story adds a dark, cheap moving marker and a numeric output; it does not change production Controls or args behavior.

## Run it

Use Node 22.22.3 and install the fork with `yarn install --immutable`, then `yarn nx run-many -t compile`. Start `cd code && yarn storybook:ui` on port 6006. With the server running, this single browser command records three untraced repetitions and exits nonzero if the manager path misses the local-state-relative budget:

```sh
STORYBOOK_URL=http://localhost:6006/ OUT_DIR=/absolute/scratch/controls-dev \
  REPEATS=3 CHECK_PATHS=manager \
  node scripts/controls-latency/storybook-controls-latency.ts
```

For built assets, run `cd code && yarn storybook:ui:build`, serve `code/storybook-static` on another port with `http-server`, and change `STORYBOOK_URL` and `OUT_DIR` in the same command. The runner drives a real pointer drag, pauses at the midpoint, delivers the exact endpoint, releases, and samples the visible numeric DOM output and marker position on animation frames for two seconds afterward. `WORKFLOWS=1` additionally checks Home, ArrowRight, blur, reset, and navigation. `CASES=finite-animation,loader-delay,before-each-delay,after-each-delay,play` measures separate lifecycle conditions. `CASES=mount` deliberately reports lost instrumentation if the document reloads. `TRACE=1` and `PROFILE=1` are diagnostic modes; exclude them from performance comparisons. `EXPERIMENT=no-a11y` is a browser-side isolation probe, not a production setting.

The runner writes per-path JSON captures, screenshots, and `summary.json` to `OUT_DIR`. The summary reports browser, package versions, revision, source hashes, errors, and budget violations. Check `summary.json` even when the expected latency regression makes the command exit 1. Run its focused checks with `yarn test scripts/controls-latency/storybook-controls-latency.test.ts`.

## Measurements

Three untraced runs per mode used Playwright Chromium 145.0.7632.6, headless at 1440x1000, on macOS with approximately 8.3 ms sampled frame intervals. Storybook, `@storybook/react`, and the accessibility addon were 11.0.0-alpha.0; React and React DOM were 18.3.1. The internal Storybook kept its onboarding, themes, docs, designs, Vitest, a11y, MCP, pseudo-states, and Chromatic addons enabled. The development server ran at port 6076; independently built assets ran at port 6077. Development and built measurements are separate captures with the same diagnostic story.

| Mode        | Input path        | Changed displayed values/s | Input-to-display p95 | Changed-value gap p95 | Post-release frame p95 | Frames over 25 ms after release |
| ----------- | ----------------- | -------------------------: | -------------------: | --------------------: | ---------------------: | ------------------------------: |
| Development | Local state       |                 94.7-100.7 |               0.7 ms |            9.3-9.4 ms |             9.2-9.3 ms |                               0 |
| Development | Preview `useArgs` |                  42.7-47.8 |         37.5-39.4 ms |          40.4-42.3 ms |           11.9-15.0 ms |                               0 |
| Development | Manager Controls  |                    5.7-8.4 |       242.6-304.6 ms |        200.8-345.6 ms |           41.5-42.8 ms |                           15-21 |
| Built       | Local state       |                 99.0-100.8 |               0.7 ms |                9.3 ms |             9.3-9.9 ms |                               0 |
| Built       | Preview `useArgs` |                  56.5-58.2 |         18.6-21.2 ms |          34.0-35.0 ms |           15.2-15.6 ms |                               0 |
| Built       | Manager Controls  |                  19.2-23.6 |        81.5-161.2 ms |         98.0-133.4 ms |           18.8-19.6 ms |                             1-3 |

Every path reached the exact final value 1000 in all six repetitions, with no displayed obsolete value after convergence. All three development manager runs remained behind during the midpoint pause; all three built runs caught up during that pause. The manager drag failed its local-state-relative cadence/latency budget in all six repetitions; the post-release budget failed in all three development runs and two built runs. The preview-only path also remained below the local cadence in both modes, even though the command above checks the manager path by default. Report input coalescing separately: requested pointer moves are not assumed to be browser-delivered input events.

## Lifecycle and limitations

With one untraced development run of each separate condition, finite animation, a 40 ms loader, a 40 ms `beforeEach`, a 40 ms `afterEach`, and `play` reached 1000 through local state, preview args, and Controls, without returning to an obsolete value. The args paths recorded `finished` phase events; the local-state path did not trigger a Storybook args lifecycle. A separate baseline workflow capture passed Home (0), ArrowRight (1), blur (1), reset (0), and navigation to the other story (0) for all three paths. That workflow run still failed the expected manager performance budgets.

The destructured-`mount` path is **incomplete**: the preview-only gesture lost its document and capture after the first update (last delivered input 8). The runner rejects that capture; it does not claim a passing final value. Additional final-completion coverage for arg-dependent loader and hook results belongs to the later interaction tickets.

DOM values sampled on animation frames are available-to-display observations, not physical scanout. Matched-value latency omits inputs whose value never appeared; delivered-input count, displayed-change count, and cadence expose that loss. The pause contributes to aggregate gaps. Phase counts in the capture do not prove all delayed work finished after the fixed observation window. The fork's configured remote Icons reference returned 404 for its `stories.json` in some captures. The runner records that exact unrelated remote error separately while still rejecting local page errors and unexpected failed resources. The test suite covers the runner's quantiles, visible-change and stale-output accounting, post-release frame interval, and missing-frame rejection.
