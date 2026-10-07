import type { CleanupCallback } from 'storybook/internal/csf';

const ANIMATION_TIMEOUT = 5000;

export function isTestEnvironment() {
  try {
    return (
      // @ts-expect-error This property exists in Vitest browser mode
      !!globalThis.__vitest_browser__ ||
      !!globalThis.window?.navigator?.userAgent?.match(/StorybookTestRunner/)
    );
  } catch {
    return false;
  }
}

// Pause all animations and transitions by overriding the CSS properties
export function pauseAnimations(atEnd = true): CleanupCallback {
  if (!('document' in globalThis && 'createElement' in globalThis.document)) {
    // Don't run in React Native
    return () => {};
  }

  // Remove all animations
  const disableStyle = document.createElement('style');
  disableStyle.textContent = `*, *:before, *:after {
    animation: none !important;
  }`;
  document.head.appendChild(disableStyle);

  // Pause any new animations
  const pauseStyle = document.createElement('style');
  pauseStyle.textContent = `*, *:before, *:after {
    animation-delay: 0s !important;
    animation-direction: ${atEnd ? 'reverse' : 'normal'} !important;
    animation-play-state: paused !important;
    transition: none !important;
  }`;
  document.head.appendChild(pauseStyle);

  // Force a reflow
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  document.body.clientHeight;

  // Now recreate all animations, getting paused in their initial state
  document.head.removeChild(disableStyle);

  return () => {
    pauseStyle.parentNode?.removeChild(pauseStyle);
  };
}

// Use the Web Animations API to wait for any animations and transitions to finish
export async function waitForAnimations(signal?: AbortSignal) {
  if (
    signal?.aborted ||
    !(
      globalThis.document &&
      'getAnimations' in globalThis.document &&
      'querySelectorAll' in globalThis.document
    )
  ) {
    // Don't run in React Native
    return;
  }

  const activeAnimations = () =>
    [globalThis.document, ...getShadowRoots(globalThis.document)]
      .flatMap((root) => root.getAnimations())
      .filter(
        (animation) =>
          (animation.pending || animation.playState === 'running') &&
          !isInfiniteAnimation(animation)
      );

  let animations = activeAnimations();
  if (!animations.length) {
    return;
  }

  let stopped = false;
  let stopWaiting = () => {};
  const interrupted = new Promise<void>((resolve) => {
    stopWaiting = () => {
      stopped = true;
      resolve();
    };
  });
  const timeout = setTimeout(stopWaiting, ANIMATION_TIMEOUT);
  signal?.addEventListener('abort', stopWaiting, { once: true });
  try {
    while (animations.length && !stopped) {
      await Promise.race([
        Promise.allSettled(animations.map((animation) => animation.finished)),
        interrupted,
      ]);
      if (!stopped) {
        animations = activeAnimations();
      }
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stopWaiting);
  }
}

function getShadowRoots(doc: Document | ShadowRoot) {
  return [doc, ...doc.querySelectorAll('*')].reduce<ShadowRoot[]>((acc, el) => {
    if ('shadowRoot' in el && el.shadowRoot) {
      acc.push(el.shadowRoot, ...getShadowRoots(el.shadowRoot));
    }
    return acc;
  }, []);
}

function isInfiniteAnimation(anim: Animation) {
  return anim.effect?.getComputedTiming().endTime === Infinity;
}
