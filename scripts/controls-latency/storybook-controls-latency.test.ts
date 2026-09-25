import assert from 'node:assert/strict';
import { test } from 'vitest';
import { quantile, summarize } from './storybook-controls-latency.ts';

test('quantiles sort without mutating capture order', () => {
  const values = [30, 10, 20];
  assert.equal(quantile(values, 0.5), 20);
  assert.equal(quantile(values, 0.95), 30);
  assert.deepEqual(values, [30, 10, 20]);
});

test('display metrics count changed values and detect obsolete output after convergence', () => {
  const summary = summarize([
    { kind: 'input', time: 0, value: 100 },
    { kind: 'frame', time: 5, value: 100, controlValue: '100' },
    { kind: 'frame', time: 10, value: 100, controlValue: '100' },
    { kind: 'input', time: 12, value: 200 },
    { kind: 'pointerup', time: 15 },
    { kind: 'frame', time: 20, value: 200, controlValue: '200' },
    { kind: 'commit', time: 21, value: 100 },
    { kind: 'frame', time: 25, value: 100, controlValue: '200' },
    { kind: 'frame', time: 30, value: 200, controlValue: '200' },
  ]);
  assert.equal(summary.displayedChanges, 1);
  assert.equal(summary.latencyMs.p95, 5);
  assert.equal(summary.settlingAfterReleaseMs, 5);
  assert.equal(summary.obsoleteDisplaysAfterConvergence, 1);
  assert.equal(summary.commitsAfterRelease, 1);
  assert.equal(summary.finalValue, 200);
  assert.deepEqual(summary.postReleaseFrameIntervalMs, {
    p50: 5,
    p95: 10,
    max: 10,
    over25: 0,
  });
});

test('post-release metrics include the crossing gap and require samples', () => {
  const summary = summarize([
    { kind: 'input', time: 0, value: 100 },
    { kind: 'frame', time: 90, value: 100, controlValue: '100' },
    { kind: 'pointerup', time: 100 },
    { kind: 'frame', time: 600, value: 100, controlValue: '100' },
    { kind: 'frame', time: 610, value: 100, controlValue: '100' },
  ]);
  assert.deepEqual(summary.postReleaseFrameIntervalMs, {
    p50: 510,
    p95: 510,
    max: 510,
    over25: 1,
  });
  assert.throws(
    () =>
      summarize([
        { kind: 'input', time: 0, value: 100 },
        { kind: 'frame', time: 90, value: 100, controlValue: '100' },
        { kind: 'pointerup', time: 100 },
        { kind: 'frame', time: 110, value: 100, controlValue: '100' },
      ]),
    /Insufficient post-release frame samples/
  );
});

test('missing frame sampling fails instead of claiming smooth output', () => {
  assert.throws(
    () =>
      summarize([
        { kind: 'input', time: 0, value: 1 },
        { kind: 'pointerup', time: 10 },
      ]),
    /Missing displayed frame samples/
  );
});

test('reports range input feedback separately when preview output still lags', () => {
  const summary = summarize([
    { kind: 'input', time: 0, value: 40 },
    {
      kind: 'frame',
      time: 5,
      value: 0,
      controlValue: '40',
      controlProgress: '40%',
      controlMin: '0',
      controlMax: '100',
    },
    {
      kind: 'frame',
      time: 10,
      value: 0,
      controlValue: '40',
      controlProgress: '40%',
      controlMin: '0',
      controlMax: '100',
    },
    { kind: 'input', time: 12, value: 80 },
    {
      kind: 'frame',
      time: 14,
      value: 0,
      controlValue: '80',
      controlProgress: '80%',
      controlMin: '0',
      controlMax: '100',
    },
    { kind: 'pointerup', time: 15 },
    {
      kind: 'frame',
      time: 20,
      value: 40,
      controlValue: '80',
      controlProgress: '80%',
      controlMin: '0',
      controlMax: '100',
    },
    {
      kind: 'frame',
      time: 25,
      value: 80,
      controlValue: '80',
      controlProgress: '80%',
      controlMin: '0',
      controlMax: '100',
    },
    {
      kind: 'frame',
      time: 30,
      value: 80,
      controlValue: '80',
      controlProgress: '80%',
      controlMin: '0',
      controlMax: '100',
    },
  ]);
  assert.equal(summary.displayedChanges, 1);
  assert.equal(summary.controlFeedback.displayedChanges, 2);
  assert.equal(summary.controlFeedback.displayedFraction, 1);
  assert.equal(summary.controlFeedback.matchedChanges, 2);
  assert.equal(summary.controlFeedback.latencyMs.p95, 5);
  assert.equal(summary.controlFeedback.finalValue, 80);
  assert.equal(summary.controlFeedback.trackSamples, 6);
  assert.equal(summary.controlFeedback.trackMismatches, 0);
});
