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

## Range feedback (#3074)

The range track now uses one theme-dependent gradient with an inline `--range-progress` percentage. The current manager value supplies both the native input value and the track percentage; the control no longer generates a different CSS class for every value. `ArgControl` already keeps edits locally while the range is focused and sends the same ordinary args updates. The range remains a controlled input, so an external reset or acknowledged value uses that existing source of truth. No other control type changes.

The browser runner now reports native control feedback separately from the preview marker. These are three untraced repetitions with the same gesture, viewport, Chromium 145, and development/built setup as the baseline. The original range feedback columns were calculated afterward from the frame/input events in the saved #3073 captures. The new sampler also reads the track's inline progress each frame, so the original and new captures have slightly different instrumentation.

| Mode        | Source             | Native value changes/s | Native matched p95 | Preview changes/s | Preview matched p95 | Track mismatches |
| ----------- | ------------------ | ---------------------: | -----------------: | ----------------: | ------------------: | ---------------: |
| Development | #3073 baseline     |              23.4-25.9 |         7.2-7.4 ms |           5.7-8.4 |      242.6-304.6 ms |     not recorded |
| Development | Static range track |              22.3-29.4 |        5.2-40.6 ms |          7.4-13.2 |      176.8-239.5 ms |                0 |
| Built       | #3073 baseline     |              38.7-46.3 |         5.5-5.6 ms |         19.2-23.6 |       81.5-161.2 ms |     not recorded |
| Built       | Static range track |              34.9-36.7 |       16.7-20.7 ms |         18.2-21.2 |       57.9-124.0 ms |                0 |

All 806 development and 1,110 built track samples matched the current native value. Every run ended at exactly 1000 without a stale value after convergence. The manager-driven Home, ArrowRight, blur, reset, and navigation checks passed in all six runs. A focused browser story also checks the range value, track, callback, focus, blur, delayed acknowledgment, and reset. The local matched p95 varied from 5.2 to 40.6 ms in development and measured 16.7-20.7 ms built, versus 7.2-7.4 ms and 5.5-5.6 ms in the saved baseline. This change does not establish a local p95 improvement. Manager work still delays some input frames, and the preview misses the drag budget in all six repetitions. Development post-release animation missed its budget three times; built post-release animation missed it twice.

## Preview args scheduling candidate (#3075)

The draft scheduler waits for a queued rerender's canvas and ordinary lifecycle before acknowledging its args. During ordinary loading, rendering, and completion, multiple updates share one pending rerender of the latest args. The active render still completes its lifecycle and may emit `STORY_FINISHED`; intermediate pending args that never render receive no `STORY_ARGS_UPDATED` acknowledgement. Failed, aborted, and removed renders do not acknowledge their args. Updates during `play` retain their immediate rerender behavior, and destructured `mount` stories still use their existing remount path. Updates for stories with no active render retain their existing immediate acknowledgement.

**The original candidate regressed preview cadence.** Three untraced repetitions per condition used the same browser runner with `CHECK_PATHS=args`; the no-a11y condition uses `EXPERIMENT=no-a11y`. All nine preview runs reached exactly 1000, with zero obsolete displays after convergence, but all nine missed the local-state-relative cadence budget. The local-state reference displayed about 95-101 changes/s during these captures. The animation-settling revision below removes this regression; #3075 remains open because the a11y-enabled path still misses its budget.

| Mode        | Condition                    | Preview displayed changes/s | Displayed changes per drag | Post-release frame p95 | Obsolete displays after convergence |
| ----------- | ---------------------------- | --------------------------: | -------------------------: | ---------------------: | ----------------------------------: |
| Development | #3073 baseline, a11y enabled |                   42.7-47.8 |               not compared |           11.9-15.0 ms |                                   0 |
| Development | Candidate, a11y enabled      |                   8.62-8.69 |                         10 |             9.2-9.3 ms |                                   0 |
| Built       | #3073 baseline, a11y enabled |                   56.5-58.2 |               not compared |           15.2-15.6 ms |                                   0 |
| Built       | Candidate, a11y enabled      |                   8.68-8.69 |                         10 |             9.3-9.3 ms |                                   0 |
| Development | Candidate, a11y disabled     |                   9.49-9.55 |                         11 |             9.1-9.2 ms |                                   0 |

In the original candidate, disabling a11y recovered less than one displayed change/s. The ordinary renderer's `waitForAnimations()` waited at least 100 ms before checking animations, including when a story had none. Serializing that work put a roughly ten-render/s ceiling on the candidate.

## Approved animation settling (2026-10-07)

[Penner #3075](https://github.com/robertpenner/penner/issues/3075) now explicitly permits animation discovery without the fixed 100 ms delay. The renderer still serializes ordinary full lifecycles.

After canvas rendering, `waitForAnimations()` queries the Web Animations API immediately. Browser style updates make CSS animations and transitions discoverable, including their start delays. Finite running or pending animations are awaited; after they settle, the document and open shadow roots are queried again to include chained animations and newly attached shadow roots. Infinite CSS and Web Animations do not block completion. The five-second limit remains, and abort or successful completion removes the timer and abort listener. An abort during animation settling cancels queued work without emitting `STORY_RENDERED` or `STORY_FINISHED` for that aborted revision.

When no finite active animations exist, completion requires no timer or extra animation frame. Animations created by unrelated future timers or animation-frame callbacks after discovery are outside this contract. Authors must create those animations during rendering or await their creation in the story lifecycle. Ordinary loaders, hooks, explicit tests, reports, and destructured `mount` behavior retain their existing paths.

Three untraced repetitions per mode and condition used the same gesture, Chromium 145.0.7632.6, Node 22.22.3, and unchanged `CHECK_PATHS=args` budgets. A11y remained enabled in the normal captures; the disabled captures used the existing `EXPERIMENT=no-a11y` browser-side isolation probe.

| Mode        | Condition     | Preview displayed changes/s | Input-to-display p95 | Budget result |
| ----------- | ------------- | --------------------------: | -------------------: | ------------- |
| Development | A11y enabled  |                   41.5-49.1 |         31.2-32.7 ms | 3/3 failed    |
| Development | A11y disabled |                  93.7-100.8 |         10.3-10.4 ms | 3/3 passed    |
| Built       | A11y enabled  |                   52.0-57.1 |         24.9-26.6 ms | 3/3 failed    |
| Built       | A11y disabled |                   99.8-99.9 |           2.3-2.4 ms | 3/3 passed    |

All twelve preview captures displayed the exact final value 1000 and zero obsolete values after convergence. The six normal captures still fail the existing relative drag budget. The six isolated captures pass every budget. This restores baseline-level normal cadence and removes the animation wait as the dominant cost; it does not establish an a11y-enabled latency fix or a manager Controls improvement. The user chose to publish this animation repair and document the remaining cadence blocker without starting #3076.

Ten animation-wait unit tests cover zero-delay completion, pending and chained finite animations, newly attached shadow roots, cancellation, the five-second limit, infinite animations, and unsupported hosts. Two additional `StoryRender` regressions verify that animation completion precedes the next queued render and that abort during settling emits no completion. Existing `PreviewWeb` regressions continue checking revision-safe args acknowledgements. The complete fork suite passes 11,884 tests, with 36 expected failures, 39 skipped, and 2 todo. Core compilation and type-checking pass.

A Chromium probe against the actual development module also verified a delayed CSS animation, a delayed CSS transition, a chained animation in a newly created nested shadow root, infinite Web Animations, and prompt cancellation. The animation-free call completed in 0.7 ms, delayed CSS settled after 128.3 ms, and abort settled in 0.3 ms. Browser-runner metadata now includes hashes of the animation wait and `StoryRender` source.
