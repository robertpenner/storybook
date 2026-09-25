import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { Browser, Frame, Locator, Page } from 'playwright';

type ObservedEvent = {
  kind: string;
  time: number;
  value?: number | null;
  detail?: {
    updatedArgs?: { value?: number };
    args?: { value?: number };
    newPhase?: string;
  };
  markerX?: number | null;
  controlValue?: string | null;
  controlProgress?: string | null;
  controlMin?: string | null;
  controlMax?: string | null;
  key?: string;
  experiment?: string;
};

declare global {
  interface Window {
    __controlsLatencyEvents: ObservedEvent[];
    __STORYBOOK_ADDONS_CHANNEL__?: {
      on: (event: string, listener: (detail: unknown) => void) => void;
    };
  }
}

export function quantile(values: number[], fraction: number): number | null {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.ceil((sorted.length - 1) * fraction)] : null;
}

export function summarize(events: ObservedEvent[]) {
  const inputs = events.filter((event) => event.kind === 'input');
  const release = events.findLast((event) => event.kind === 'pointerup');
  const frames = events.filter((event) => event.kind === 'frame' && event.value != null);
  assert.ok(frames.length >= 2, 'Missing displayed frame samples');
  const changed = frames.filter(
    (frame, index) => index === 0 || frame.value !== frames[index - 1].value
  );
  const firstInput = inputs[0];
  const lastInput = inputs.at(-1);
  assert.ok(firstInput && lastInput && release, 'Missing real input/release events');
  const during = changed.filter(
    (frame) => frame.time >= firstInput.time && frame.time <= release.time
  );
  const gaps = during.slice(1).map((frame, index) => frame.time - during[index].time);
  const latencies = [];
  for (const frame of during) {
    const input = inputs.findLast(
      (input) => input.value === frame.value && input.time <= frame.time
    );
    if (input) latencies.push(frame.time - input.time);
  }
  const controlFrames = events.filter(
    (event) =>
      event.kind === 'frame' && event.controlValue !== null && event.controlValue !== undefined
  );
  assert.ok(controlFrames.length >= 2, 'Missing range input frame samples');
  const changedControls = controlFrames.filter(
    (frame, index) => index === 0 || frame.controlValue !== controlFrames[index - 1].controlValue
  );
  const duringControl = changedControls.filter(
    (frame) => frame.time >= firstInput.time && frame.time <= release.time
  );
  const controlLatencies = duringControl.flatMap((frame) => {
    const input = inputs.findLast(
      (input) => input.value === Number(frame.controlValue) && input.time <= frame.time
    );
    return input ? [frame.time - input.time] : [];
  });
  const trackFrames = controlFrames.filter((frame) => frame.controlProgress?.trim());
  const trackMismatches = trackFrames.filter((frame) => {
    const progress = frame.controlProgress!.trim();
    const min = Number(frame.controlMin);
    const max = Number(frame.controlMax);
    const value = Number(frame.controlValue);
    const percentage = ((value - min) / (max - min)) * 100;
    const expected = Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
    const observed = Number.parseFloat(progress);
    return (
      !progress.endsWith('%') || !Number.isFinite(observed) || Math.abs(observed - expected) > 0.01
    );
  });
  const convergence = frames.find(
    (frame) => frame.time >= lastInput.time && frame.value === lastInput.value
  );
  const frameIntervals = frames.slice(1).map((frame, index) => frame.time - frames[index].time);
  const postReleaseWindowMs = 2000;
  const postReleaseFrames = frames.filter(
    (frame) => frame.time >= release.time && frame.time <= release.time + postReleaseWindowMs
  );
  const firstPostReleaseIndex = frames.findIndex((frame) => frame.time >= release.time);
  assert.ok(
    firstPostReleaseIndex > 0 && postReleaseFrames.length >= 2,
    'Insufficient post-release frame samples'
  );
  const postReleaseFrameIntervals = postReleaseFrames.map((frame, index) => {
    const previous = index === 0 ? frames[firstPostReleaseIndex - 1] : postReleaseFrames[index - 1];
    return frame.time - previous.time;
  });
  const obsolete = changed.filter(
    (frame) => convergence && frame.time > convergence.time && frame.value !== lastInput.value
  );
  function stageLatency(
    kind: string,
    valueOf: (event: ObservedEvent) => number | undefined | null
  ) {
    const latencies = events
      .filter((event) => event.kind === kind)
      .flatMap((event) => {
        const input = inputs.findLast(
          (input) => input.value === valueOf(event) && input.time <= event.time
        );
        return input ? [event.time - input.time] : [];
      });
    return {
      count: latencies.length,
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
    };
  }
  return {
    inputs: inputs.length,
    displayedChanges: during.length,
    displayedFraction: during.length / inputs.length,
    displayedHz: (during.length * 1000) / (release.time - firstInput.time),
    controlFeedback: {
      displayedChanges: duringControl.length,
      displayedFraction: duringControl.length / inputs.length,
      displayedHz: (duringControl.length * 1000) / (release.time - firstInput.time),
      matchedChanges: controlLatencies.length,
      latencyMs: {
        p50: quantile(controlLatencies, 0.5),
        p95: quantile(controlLatencies, 0.95),
        max: quantile(controlLatencies, 1),
      },
      finalValue: Number(controlFrames.at(-1)?.controlValue),
      trackSamples: trackFrames.length,
      trackMismatches: trackMismatches.length,
    },
    frameIntervalMs: quantile(frameIntervals, 0.5),
    postReleaseFrameIntervalMs: {
      p50: quantile(postReleaseFrameIntervals, 0.5),
      p95: quantile(postReleaseFrameIntervals, 0.95),
      max: quantile(postReleaseFrameIntervals, 1),
      over25: postReleaseFrameIntervals.filter((interval) => interval > 25).length,
    },
    latencyMs: {
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      max: quantile(latencies, 1),
    },
    changedGapMs: {
      p50: quantile(gaps, 0.5),
      p95: quantile(gaps, 0.95),
      max: quantile(gaps, 1),
    },
    finalValue: frames.at(-1)?.value,
    expectedFinalValue: lastInput.value,
    settlingAfterReleaseMs: convergence ? Math.max(0, convergence.time - release.time) : null,
    obsoleteDisplaysAfterConvergence: obsolete.length,
    commitsAfterRelease: events.filter(
      (event) => event.kind === 'commit' && event.time > release.time
    ).length,
    stageLatencyMs: {
      previewReceipt: stageLatency('updateStoryArgs', (event) => event.detail?.updatedArgs?.value),
      commit: stageLatency('commit', (event) => event.value),
      previewAcknowledgement: stageLatency(
        'storyArgsUpdated',
        (event) => event.detail?.args?.value
      ),
      managerAcknowledgement: stageLatency('manager:ack', (event) => event.detail?.args?.value),
    },
    lifecycleEventsAfterRelease: events.filter(
      (event) => event.kind === 'storyRenderPhaseChanged' && event.time > release.time
    ).length,
    phases: events
      .filter((event) => event.kind === 'storyRenderPhaseChanged')
      .reduce<Record<string, number>>((counts, event) => {
        const phase = event.detail?.newPhase;
        assert.ok(phase, 'Missing Storybook render phase');
        counts[phase] = (counts[phase] ?? 0) + 1;
        return counts;
      }, {}),
  };
}

function instrument(experiment: string) {
  const events: ObservedEvent[] = [];
  window.__controlsLatencyEvents = events;
  const record = (kind: string, detail: Partial<ObservedEvent> = {}) =>
    events.push({
      time: performance.timeOrigin + performance.now(),
      kind,
      ...detail,
    });
  window.addEventListener('controls-latency', (event) => {
    if (!(event instanceof CustomEvent)) return;
    record(event.detail.kind, event.detail);
  });
  if (!location.pathname.endsWith('iframe.html')) {
    const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
    if (!channel) throw new Error('Manager channel is unavailable');
    channel.on('storyArgsUpdated', (detail: ObservedEvent['detail']) =>
      record('manager:ack', { detail })
    );
  } else if (experiment === 'no-a11y') {
    const render = window.__STORYBOOK_PREVIEW__.storyRenders[0];
    render.story.parameters.a11y.test = 'off';
    record('experiment', { experiment });
  }
  document.addEventListener(
    'input',
    (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'range') {
        record('input', { value: Number(event.target.value) });
      }
    },
    true
  );
  for (const kind of ['pointerdown', 'pointerup', 'blur', 'keydown']) {
    document.addEventListener(
      kind,
      (event) => record(kind, { key: event instanceof KeyboardEvent ? event.key : undefined }),
      true
    );
  }
  function frame() {
    const output = document.querySelector('[data-latency-output]');
    const marker = document.querySelector('[data-latency-marker]');
    const control = document.querySelector<HTMLInputElement>('input[type="range"]');
    record('frame', {
      value: output ? Number(output.textContent) : null,
      markerX: marker?.getBoundingClientRect().x ?? null,
      controlValue: control?.value ?? null,
      controlProgress: control?.style.getPropertyValue('--range-progress') ?? null,
      controlMin: control?.min ?? null,
      controlMax: control?.max ?? null,
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function waitFrames(page: Page, count: number) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        function next() {
          if (--count <= 0) resolve();
          else requestAnimationFrame(next);
        }
        requestAnimationFrame(next);
      }),
    count
  );
}

async function verifyInteractions(
  page: Page,
  preview: Frame,
  slider: Locator,
  inputPath: string,
  base: string,
  storyCase: string
) {
  const checks: Array<{ name: string; value: number }> = [];
  async function expectValue(value: number, name: string) {
    await preview.waitForFunction(
      (value) => document.querySelector('[data-latency-output]')?.textContent === String(value),
      value,
      { timeout: 5000 }
    );
    await waitFrames(page, 30);
    assert.equal(
      await preview.locator('[data-latency-output]').textContent(),
      String(value),
      `${name}: obsolete value returned`
    );
    if (inputPath === 'manager') {
      const control = await slider.evaluate((input: HTMLInputElement) => ({
        value: Number(input.value),
        progress: input.style.getPropertyValue('--range-progress').trim(),
      }));
      assert.equal(control.value, value, `${name}: manager range value is stale`);
      assert.ok(
        Math.abs(Number.parseFloat(control.progress) - value / 10) < 0.01,
        `${name}: manager track is stale`
      );
    }
    checks.push({ name, value });
  }
  await slider.press('Home');
  await expectValue(0, 'keyboard Home');
  await slider.press('ArrowRight');
  await expectValue(1, 'keyboard ArrowRight');
  await slider.press('Tab');
  await expectValue(1, 'blur');
  await page
    .getByRole('button', {
      name: inputPath === 'manager' ? 'Reset controls' : 'Reset',
      exact: true,
    })
    .click();
  await expectValue(0, 'reset');
  await slider.press('End');
  const nextCase = storyCase === 'baseline' ? 'finite-animation' : 'baseline';
  if (inputPath === 'manager') {
    await page.locator(`#diagnostics-controls-latency--${nextCase}`).click();
    await expectValue(0, 'navigation during pending update');
  } else {
    await page.goto(
      `${base}iframe.html?id=diagnostics-controls-latency--${nextCase}&viewMode=story&latencyInput=${inputPath}`
    );
    await page.waitForFunction(
      () => document.querySelector('[data-latency-output]')?.textContent === '0',
      undefined,
      { timeout: 5000 }
    );
    checks.push({
      name: 'document navigation during pending update',
      value: 0,
    });
  }
  return checks;
}

async function measure(
  browser: Browser,
  {
    base,
    out,
    storyCase,
    inputPath,
    repetition,
  }: {
    base: string;
    out: string;
    storyCase: string;
    inputPath: string;
    repetition: number;
  }
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const externalRefErrors: string[] = [];
  const recordError = (url: string, message: string) => {
    const target =
      url.includes('/stories.json') && url.includes('main--64b56e737c0aeefed9d5e675.chromatic.com')
        ? externalRefErrors
        : errors;
    target.push(`${url}: ${message}`);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') recordError(message.location().url, message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) recordError(response.url(), String(response.status()));
  });
  const observations: Array<{
    kind: string;
    url?: string;
    frames?: Array<{ url: string; body: string }>;
  }> = [];
  page.on('framenavigated', (frame) => observations.push({ kind: 'navigation', url: frame.url() }));
  const story = `diagnostics-controls-latency--${storyCase}`;
  const url =
    inputPath === 'manager'
      ? `${base}?path=/story/${story}`
      : `${base}iframe.html?id=${story}&viewMode=story&latencyInput=${inputPath}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const canvas = inputPath === 'manager' ? page.frameLocator('#storybook-preview-iframe') : page;
  await canvas.locator('[data-latency-output]').waitFor({ timeout: 60000 });
  const preview =
    inputPath === 'manager'
      ? page.frames().find((frame) => frame.url().includes('iframe.html'))
      : page.mainFrame();
  assert.ok(preview, 'Storybook preview frame is unavailable');
  await preview.waitForFunction(
    () => window.__STORYBOOK_PREVIEW__.currentRender?.phase === 'finished',
    undefined,
    { timeout: 30000 }
  );
  if (inputPath === 'manager') {
    await page.getByRole('tab', { name: /^Controls/ }).click();
  }
  const slider = page.locator('input[type="range"]').first();
  await slider.waitFor();
  await waitFrames(page, 30);
  for (const frame of page.frames())
    await frame.evaluate(instrument, process.env.EXPERIMENT ?? 'stock');
  await waitFrames(page, 3);
  assert.ok(
    await preview.evaluate(() =>
      window.__controlsLatencyEvents.some((event) => event.kind === 'frame' && event.value !== null)
    ),
    'Preview frame sampler is not running'
  );
  observations.push({
    kind: 'before-drag',
    frames: await Promise.all(
      page.frames().map(async (frame) => ({
        url: frame.url(),
        body: (await frame.locator('body').innerText()).slice(-1000),
      }))
    ),
  });
  const box = await slider.boundingBox();
  assert.ok(box, 'Range control is not visible');
  const stem = `${storyCase}-${inputPath}-${repetition}`;
  const profiler = process.env.PROFILE === '1' ? await context.newCDPSession(page) : null;
  if (profiler) {
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
  }
  if (process.env.TRACE === '1')
    await context.tracing.start({ screenshots: true, snapshots: true });
  for (const frame of page.frames())
    await frame.evaluate(() => {
      window.__controlsLatencyEvents.length = 0;
    });
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  const started = performance.now();
  const dispatches: Array<{ step: number; time: number }> = [];
  const pendingMoves: Array<Promise<void>> = [];
  for (let step = 1; step <= 120; step++) {
    const scheduled = started + (step * 1000) / 120 + (step > 60 ? 150 : 0);
    await delay(Math.max(0, scheduled - performance.now()));
    dispatches.push({ step, time: performance.timeOrigin + performance.now() });
    pendingMoves.push(
      page.mouse.move(box.x + 8 + ((box.width - 16) * step) / 120, box.y + box.height / 2)
    );
  }
  const requestedRelease = performance.timeOrigin + performance.now();
  await Promise.all(pendingMoves);
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
  await page.mouse.up();
  await delay(2200);
  observations.push({
    kind: 'after-drag',
    frames: await Promise.all(
      page.frames().map(async (frame) => ({
        url: frame.url(),
        body: (await frame.locator('body').innerText()).slice(-1000),
      }))
    ),
  });
  const sampledFrames = [...new Set([page.mainFrame(), preview])];
  const captures = await Promise.all(
    sampledFrames.map(async (frame) => ({
      url: frame.url(),
      events: await frame.evaluate(() => window.__controlsLatencyEvents),
    }))
  );
  await writeFile(
    resolve(out, `${stem}-capture.json`),
    JSON.stringify({ captures, observations, errors, externalRefErrors }, null, 2)
  );
  assert.ok(
    captures.every((capture) => Array.isArray(capture.events)),
    'A measured document reloaded and lost its capture'
  );
  const events = captures
    .flatMap((capture) => capture.events)
    .sort((left, right) => left.time - right.time);
  const resumeTime = dispatches[60].time;
  const pauseInput = events.findLast((event) => event.kind === 'input' && event.time < resumeTime);
  const pauseFrame = events.findLast(
    (event) => event.kind === 'frame' && event.value !== null && event.time < resumeTime
  );
  const summary = {
    ...summarize(events),
    gestureEndpointReached: false,
    pause: {
      inputValue: pauseInput?.value,
      displayedValue: pauseFrame?.value,
      converged: pauseInput?.value === pauseFrame?.value,
    },
    releaseDeliveryDelayMs: 0,
  };
  summary.gestureEndpointReached = summary.expectedFinalValue === 1000;
  const deliveredRelease = events.findLast((event) => event.kind === 'pointerup');
  assert.ok(deliveredRelease, 'Pointer release was not delivered');
  summary.releaseDeliveryDelayMs = deliveredRelease.time - requestedRelease;
  await page.screenshot({ path: resolve(out, `${stem}.png`) });
  if (process.env.TRACE === '1') await context.tracing.stop({ path: resolve(out, `${stem}.zip`) });
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    await writeFile(resolve(out, `${stem}.cpuprofile`), JSON.stringify(profile));
  }
  const resources = await preview.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => entry.name)
  );
  const capture = {
    url,
    summary,
    events,
    errors,
    externalRefErrors,
    observations,
    dispatches,
    requestedRelease,
    resources,
  };
  await writeFile(resolve(out, `${stem}.json`), JSON.stringify(capture, null, 2));
  assert.deepEqual(errors, [], 'Browser errors');
  assert.equal(summary.finalValue, summary.expectedFinalValue, 'Final output is stale');
  if (inputPath === 'manager') {
    assert.equal(
      summary.controlFeedback.finalValue,
      summary.expectedFinalValue,
      'Final manager range value is stale'
    );
    assert.ok(summary.controlFeedback.trackSamples > 0, 'Manager track was not sampled');
    assert.equal(summary.controlFeedback.trackMismatches, 0, 'Manager track is stale');
  }
  assert.equal(
    summary.obsoleteDisplaysAfterConvergence,
    0,
    'Obsolete output appeared after convergence'
  );
  if (process.env.WORKFLOWS === '1') {
    const checks = await verifyInteractions(
      page,
      preview,
      slider,
      inputPath,
      base,
      storyCase
    ).catch(async (error) => {
      await writeFile(
        resolve(out, `${stem}-workflow-failure.json`),
        JSON.stringify(
          {
            error: error.message,
            url: page.url(),
            state: await preview.evaluate(() => ({
              body: document.body.innerText,
              phase: window.__STORYBOOK_PREVIEW__.currentRender?.phase,
              storyId: window.__STORYBOOK_PREVIEW__.currentRender?.id,
              args: window.__STORYBOOK_PREVIEW__.currentRender?.storyContext().args,
              events: window.__controlsLatencyEvents,
            })),
          },
          null,
          2
        )
      );
      throw error;
    });
    await writeFile(resolve(out, `${stem}.json`), JSON.stringify({ ...capture, checks }, null, 2));
  }
  await context.close();
  return { storyCase, inputPath, repetition, ...summary };
}

export async function main() {
  const base = `${(process.env.STORYBOOK_URL ?? 'http://localhost:6074/').replace(/\/$/, '')}/`;
  const out = process.env.OUT_DIR;
  const experiment = process.env.EXPERIMENT ?? 'stock';
  const checkPaths = (process.env.CHECK_PATHS ?? 'args,manager').split(',');
  assert.ok(
    checkPaths.length && checkPaths.every((inputPath) => ['args', 'manager'].includes(inputPath)),
    'Invalid CHECK_PATHS'
  );
  assert.ok(['stock', 'no-a11y'].includes(experiment), 'Unknown diagnostic experiment');
  assert.ok(out, 'Set OUT_DIR to an allocated agent scratch directory');
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({
    headless: process.env.HEADED !== '1',
    channel: process.env.BROWSER_CHANNEL,
  });
  const runs = [];
  const failures = [];
  const checkout = fileURLToPath(new URL('../../', import.meta.url));
  const metadata = {
    browser: browser.version(),
    headless: process.env.HEADED !== '1',
    node: process.version,
    checkout,
    revision: execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    versions: Object.fromEntries(
      ['storybook', '@storybook/react', '@storybook/addon-a11y', 'react', 'react-dom'].map(
        (name) => [
          name,
          JSON.parse(readFileSync(resolve(checkout, `node_modules/${name}/package.json`), 'utf8'))
            .version,
        ]
      )
    ),
    sourceHashes: Object.fromEntries(
      [
        'code/.storybook/diagnostics/ControlsLatency.stories.tsx',
        'code/.storybook/main.ts',
        'code/addons/docs/src/blocks/controls/Range.tsx',
        'code/core/template/stories/preview.ts',
        'scripts/controls-latency/storybook-controls-latency.ts',
      ].map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(resolve(checkout, name)))
          .digest('hex'),
      ])
    ),
    base,
    experiment,
    checkPaths,
    trace: process.env.TRACE === '1',
    budgets: {
      minimumRelativeDisplayedHz: 0.8,
      p95Latency: 'max(2 * local p95, 2 * local frame interval)',
      p95ChangedGap: 'max(2 * local p95, 3 * local frame interval)',
      p95PostReleaseFrameInterval: 'max(2 * local p95, 2 * local frame interval)',
      postReleaseFramesOver25Ms: 'local count + 2',
    },
  };
  let complete = false;
  try {
    for (const storyCase of (process.env.CASES ?? 'baseline').split(',')) {
      for (let repetition = 1; repetition <= Number(process.env.REPEATS ?? 3); repetition++) {
        const comparison = [];
        for (const inputPath of ['local', 'args', 'manager']) {
          const result = await measure(browser, {
            base,
            out,
            storyCase,
            inputPath,
            repetition,
          });
          runs.push(result);
          comparison.push(result);
          if (!result.gestureEndpointReached)
            failures.push(
              `${storyCase}/${inputPath}/${repetition}: pointer gesture did not reach 1000 (last input ${result.expectedFinalValue})`
            );
          console.log(JSON.stringify(result));
        }
        const local = comparison[0];
        for (const result of comparison.slice(1)) {
          if (!checkPaths.includes(result.inputPath)) continue;
          if (
            result.displayedHz < local.displayedHz * 0.8 ||
            result.latencyMs.p95 > Math.max(local.latencyMs.p95 * 2, local.frameIntervalMs * 2) ||
            result.changedGapMs.p95 >
              Math.max(local.changedGapMs.p95 * 2, local.frameIntervalMs * 3)
          ) {
            failures.push(
              `${storyCase}/${result.inputPath}/${repetition}: output falls below local-state budget`
            );
          }
          if (
            result.postReleaseFrameIntervalMs.p95 >
              Math.max(local.postReleaseFrameIntervalMs.p95 * 2, local.frameIntervalMs * 2) ||
            result.postReleaseFrameIntervalMs.over25 > local.postReleaseFrameIntervalMs.over25 + 2
          ) {
            failures.push(
              `${storyCase}/${result.inputPath}/${repetition}: post-release animation falls below local-state budget`
            );
          }
        }
      }
    }
    complete = true;
    console.log(
      `VERDICT: ${failures.length ? 'FAIL' : 'PASS'} (${failures.length} budget violations, ${runs.length} runs)`
    );
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    failures.push(`Capture stopped: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    await writeFile(
      resolve(out, 'summary.json'),
      JSON.stringify({ ...metadata, complete, runs, failures }, null, 2)
    );
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
