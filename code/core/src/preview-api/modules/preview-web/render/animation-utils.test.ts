import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForAnimations } from './animation-utils.ts';

function createAnimation(playState = 'running', pending = false, endTime = 120) {
  let finish = () => {};
  let cancel = () => {};
  const animation = {
    playState,
    pending,
    effect: { getComputedTiming: () => ({ endTime }) },
    finished: new Promise<void>((resolve, reject) => {
      finish = () => {
        animation.playState = 'finished';
        animation.pending = false;
        resolve();
      };
      cancel = () => {
        animation.playState = 'idle';
        animation.pending = false;
        reject(new DOMException('Animation cancelled', 'AbortError'));
      };
    }),
  };
  return { animation, finish, cancel };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', {
    getAnimations: vi.fn(() => []),
    querySelectorAll: vi.fn(() => []),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('waitForAnimations', () => {
  it('completes an animation-free render without waiting for a timer', async () => {
    let completed = false;
    const waiting = waitForAnimations().then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toBe(true);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a pending finite animation before completing', async () => {
    const { animation, finish } = createAnimation('paused', true);
    vi.stubGlobal('document', {
      getAnimations: () => [animation],
      querySelectorAll: () => [],
    });
    let completed = false;
    const waiting = waitForAnimations().then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);

    finish();
    await waiting;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores infinite Web Animations without delaying completion', async () => {
    const { animation } = createAnimation('running', false, Infinity);
    vi.stubGlobal('document', {
      getAnimations: () => [animation],
      querySelectorAll: () => [],
    });
    let completed = false;
    const waiting = waitForAnimations().then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(true);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a running finite animation and rechecks for a chained animation', async () => {
    const first = createAnimation();
    const next = createAnimation();
    vi.stubGlobal('document', {
      getAnimations: () =>
        first.animation.playState === 'finished' ? [next.animation] : [first.animation],
      querySelectorAll: () => [],
    });
    let completed = false;
    const waiting = waitForAnimations().then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    first.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);

    next.finish();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discovers finite animations in shadow roots added while an animation settles', async () => {
    const first = createAnimation();
    const nested = createAnimation();
    const shadowRoot = {
      getAnimations: () => [nested.animation],
      querySelectorAll: () => [],
    };
    vi.stubGlobal('document', {
      getAnimations: () => [first.animation],
      querySelectorAll: () => (first.animation.playState === 'finished' ? [{ shadowRoot }] : []),
    });
    let completed = false;
    const waiting = waitForAnimations().then(() => {
      completed = true;
    });

    first.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);

    nested.finish();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a cancelled animation as settled', async () => {
    const { animation, cancel } = createAnimation();
    vi.stubGlobal('document', {
      getAnimations: () => [animation],
      querySelectorAll: () => [],
    });
    const waiting = waitForAnimations();

    cancel();

    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles promptly on abort without waiting for an unfinished animation', async () => {
    const { animation } = createAnimation();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    vi.stubGlobal('document', {
      getAnimations: () => [animation],
      querySelectorAll: () => [],
    });
    let completed = false;
    const waiting = waitForAnimations(controller.signal).then(() => {
      completed = true;
    });

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toBe(true);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('stops waiting after five seconds and removes its abort listener', async () => {
    const { animation } = createAnimation();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    vi.stubGlobal('document', {
      getAnimations: () => [animation],
      querySelectorAll: () => [],
    });
    let completed = false;
    const waiting = waitForAnimations(controller.signal).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;

    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not inspect animations after the render has already been aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const getAnimations = vi.fn(() => []);
    vi.stubGlobal('document', { getAnimations, querySelectorAll: () => [] });

    await waitForAnimations(controller.signal);

    expect(getAnimations).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes when the host does not support Web Animations', async () => {
    vi.stubGlobal('document', undefined);

    await waitForAnimations();

    expect(vi.getTimerCount()).toBe(0);
  });
});
