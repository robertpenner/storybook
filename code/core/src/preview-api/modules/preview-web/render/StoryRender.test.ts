// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Channel } from 'storybook/internal/channels';
import {
  STORY_FINISHED,
  STORY_RENDERED,
  STORY_RENDER_PHASE_CHANGED,
} from 'storybook/internal/core-events';
import type {
  PreparedStory,
  RenderContext,
  Renderer,
  StoryContext,
  StoryIndexEntry,
} from 'storybook/internal/types';

import { ReporterAPI, type StoryStore } from '../../store/index.ts';
import { ARGS_INTERACTION_RESULT } from '../../../../core-events/index.ts';
import { PREPARE_ABORTED } from './Render.ts';
import { StoryRender, serializeError } from './StoryRender.ts';

const entry = {
  type: 'story',
  subtype: 'story',
  id: 'component--a',
  name: 'A',
  title: 'component',
  importPath: './component.stories.ts',
} as StoryIndexEntry;

const createGate = (): [Promise<void>, () => void] => {
  let openGate = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return [gate, openGate];
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

window.location = { reload: vi.fn() } as any;

const mountSpy = vi.fn(async (context) => {
  await context.renderToCanvas();
  return context.canvas;
});

const buildStory = (overrides: Partial<PreparedStory> = {}): PreparedStory =>
  ({
    id: 'id',
    title: 'title',
    name: 'name',
    tags: [],
    applyLoaders: vi.fn(),
    applyBeforeEach: vi.fn(() => []),
    applyAfterEach: vi.fn(),
    unboundStoryFn: vi.fn(),
    playFunction: vi.fn(),
    mount: (context: StoryContext) => () => mountSpy(context),
    ...overrides,
  }) as any;

const buildStore = (overrides: Partial<StoryStore<Renderer>> = {}): StoryStore<Renderer> =>
  ({
    args: { get: vi.fn(() => ({})) },
    getStoryContext: () => ({
      reporting: new ReporterAPI(),
    }),
    addCleanupCallbacks: vi.fn(),
    cleanupStory: vi.fn(),
    ...overrides,
  }) as any;

const interactiveRender = (
  overrides: Partial<PreparedStory> = {},
  canvas = vi.fn(async (_context: RenderContext<Renderer>) => {})
) => {
  let args = { value: 0 };
  const store = buildStore();
  vi.mocked(store.args.get).mockImplementation(() => args);
  const getStoryContext = store.getStoryContext.bind(store);
  store.getStoryContext = (story, options) => ({
    ...getStoryContext(story, options),
    args,
    reporting: new ReporterAPI(),
  });
  const story = buildStory({
    playFunction: undefined,
    usesMount: false,
    hasBeforeEach: false,
    applyLoaders: vi.fn(async () => ({ projectValue: 2 })),
    ...overrides,
  });
  const channel = new Channel({});
  const render = new StoryRender(
    channel,
    store,
    canvas,
    { showMain: vi.fn(), showException: vi.fn(), showError: vi.fn() },
    entry.id,
    'story',
    { autoplay: false },
    story
  );
  return {
    render,
    story,
    channel,
    setArgs: (value: number) => {
      args = { value };
    },
  };
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StoryRender', () => {
  it('waits for final finite animations and after-hook reports before returning a result', async () => {
    const [animationFinished, releaseAnimation] = createGate();
    const [auditFinished, releaseAudit] = createGate();
    let animating = false;
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      getAnimations: () =>
        animating
          ? [
              {
                playState: 'running',
                pending: false,
                effect: { getComputedTiming: () => ({ endTime: 120 }) },
                finished: animationFinished,
              },
            ]
          : [],
    });
    const after = vi.fn(async (context: StoryContext) => {
      if (context.args.value !== 9) return;
      await auditFinished;
      context.reporting.addReport({ type: 'a11y', status: 'failed', result: 'violation' });
    });
    const { render, setArgs } = interactiveRender({ applyAfterEach: after });
    await render.renderToElement({});
    render.beginArgsInteraction('gesture');
    animating = true;
    setArgs(9);
    render.updateArgsInteraction('gesture');
    await vi.waitFor(() => expect(render.phase).toBe('finished'));
    expect(after).toHaveBeenCalledOnce();
    const completion = render.finishArgsInteraction('gesture');
    const resolved = vi.fn();
    void completion.then(resolved);
    await vi.waitFor(() => expect(render.phase).toBe('completing'));
    expect(resolved).not.toHaveBeenCalled();
    animating = false;
    releaseAnimation();
    await vi.waitFor(() => expect(render.phase).toBe('afterEach'));
    expect(resolved).not.toHaveBeenCalled();
    releaseAudit();
    await expect(completion).resolves.toEqual({ status: 'failed' });
  });

  it('teardown cancels final completion and drains pending transient values', async () => {
    const rendered: number[] = [];
    const canvas = vi.fn(async ({ storyContext }: RenderContext<Renderer>) => {
      rendered.push(storyContext.args.value);
      if (storyContext.args.value === 1) {
        await new Promise<void>((resolve) => {
          storyContext.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    });
    const { render, setArgs, channel } = interactiveRender({}, canvas);
    const results: unknown[] = [];
    channel.on(ARGS_INTERACTION_RESULT, (result) => results.push(result));
    await render.renderToElement({});
    render.beginArgsInteraction('gesture');
    setArgs(1);
    render.updateArgsInteraction('gesture');
    setArgs(9);
    render.updateArgsInteraction('gesture');
    const completion = render.finishArgsInteraction('gesture');
    await render.teardown();
    await expect(completion).resolves.toEqual({ status: 'cancelled' });
    expect(rendered).toEqual([0, 1]);
    expect(results).toEqual([
      {
        storyId: entry.id,
        interactionId: 'gesture',
        status: 'cancelled',
      },
    ]);
  });

  it('supports another gesture after an ordinary remount', async () => {
    const { render, setArgs } = interactiveRender();
    await render.renderToElement({});
    render.beginArgsInteraction('old');
    setArgs(1);
    render.updateArgsInteraction('old');
    await render.remount();
    expect(render.beginArgsInteraction('new')).toBe(true);
    await expect(render.finishArgsInteraction('new')).resolves.toEqual({
      status: 'completed',
      args: { value: 1 },
    });
  });

  it('renders again when final args change loader output', async () => {
    const rendered: number[] = [];
    const { render, setArgs } = interactiveRender(
      { applyLoaders: async (context) => ({ loadedValue: context.args.value }) },
      vi.fn(async ({ storyContext }) => {
        rendered.push(storyContext.args.value + storyContext.loaded.loadedValue);
      })
    );
    await render.renderToElement({});
    render.beginArgsInteraction('gesture');
    setArgs(9);
    render.updateArgsInteraction('gesture');
    await expect(render.finishArgsInteraction('gesture')).resolves.toEqual({
      status: 'completed',
      args: { value: 9 },
    });
    expect(rendered).toEqual([0, 9, 18]);
  });

  it('renders after final before hooks and conservatively rerenders mutable loaded objects', async () => {
    for (const overrides of [
      { hasBeforeEach: true, applyBeforeEach: vi.fn(async () => []) },
      { applyLoaders: vi.fn(async () => ({ shared: { value: 2 } })) },
    ]) {
      const canvas = vi.fn(async (_context: RenderContext<Renderer>) => {});
      const { render, setArgs, story } = interactiveRender(overrides, canvas);
      await render.renderToElement({});
      render.beginArgsInteraction('gesture');
      setArgs(9);
      render.updateArgsInteraction('gesture');
      await expect(render.finishArgsInteraction('gesture')).resolves.toEqual({
        status: 'completed',
        args: { value: 9 },
      });
      expect(canvas).toHaveBeenCalledTimes(3);
      expect(story.applyBeforeEach).toHaveBeenCalledTimes(2);
      expect(story.applyLoaders).toHaveBeenCalledTimes(2);
    }
  });

  it.each(['throw', 'showException', 'showError'] as const)(
    'recovers a transient %s with ordinary final rendering',
    async (failure) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let calls = 0;
      const canvas = vi.fn(async (context: RenderContext<Renderer>) => {
        calls += 1;
        if (calls !== 2) return;
        if (failure === 'throw') throw new Error('transient failure');
        if (failure === 'showException') context.showException(new Error('transient failure'));
        if (failure === 'showError')
          context.showError({ title: 'transient failure', description: '' });
      });
      const { render, setArgs } = interactiveRender({}, canvas);
      await render.renderToElement({});
      render.beginArgsInteraction('gesture');
      setArgs(9);
      render.updateArgsInteraction('gesture');
      await expect(render.finishArgsInteraction('gesture')).resolves.toEqual({
        status: 'completed',
        args: { value: 9 },
      });
      expect(canvas).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining(
          failure === 'showError'
            ? { title: 'transient failure' }
            : { message: 'transient failure' }
        )
      );
      errorSpy.mockRestore();
    }
  );

  it('binds resolved mount, renderToCanvas, and step to the transient args', async () => {
    let context: StoryContext | undefined;
    const values: number[] = [];
    const canvas = vi.fn(async ({ storyContext }: RenderContext<Renderer>) => {
      values.push(storyContext.args.value);
      if (storyContext.args.value === 9) context = storyContext;
    });
    const { render, setArgs } = interactiveRender(
      { runStep: async (_label, play, current) => play(current) },
      canvas
    );
    await render.renderToElement({});
    render.beginArgsInteraction('gesture');
    setArgs(9);
    render.updateArgsInteraction('gesture');
    await tick();
    if (!context) throw new Error('Transient canvas was not rendered');
    expect(await context.mount()).toEqual(context.canvas);
    expect(values.at(-1)).toBe(9);
    await context.step('transient', async (current) => {
      expect(current.args.value).toBe(9);
    });
    await expect(render.finishArgsInteraction('gesture')).resolves.toEqual({
      status: 'completed',
      args: { value: 9 },
    });
  });

  it('does not complete when final rendering fails', async () => {
    const canvas = vi.fn(async (context: RenderContext<Renderer>) => {
      if (context.storyContext.args.value === 9) throw new Error('render failed');
    });
    const { render, setArgs } = interactiveRender({}, canvas);
    await render.renderToElement({});
    render.beginArgsInteraction('gesture');
    setArgs(9);
    render.updateArgsInteraction('gesture');
    await expect(render.finishArgsInteraction('gesture')).resolves.toEqual({ status: 'failed' });
  });

  it('cancels an obsolete finish and serializes the succeeding ordinary update', async () => {
    const [gate, release] = createGate();
    const rendered: number[] = [];
    const canvas = vi.fn(async ({ storyContext }: RenderContext<Renderer>) => {
      rendered.push(storyContext.args.value);
      if (storyContext.args.value === 1) await gate;
    });
    const { render, setArgs } = interactiveRender({}, canvas);
    await render.renderToElement({});
    render.beginArgsInteraction('gesture');
    setArgs(1);
    render.updateArgsInteraction('gesture');
    const obsolete = render.finishArgsInteraction('gesture');
    setArgs(9);
    const ordinary = render.rerender();
    expect(rendered).toEqual([0, 1]);
    release();
    await expect(obsolete).resolves.toEqual({ status: 'cancelled' });
    await expect(ordinary).resolves.toEqual({ value: 9 });
    expect(rendered).toEqual([0, 1, 9]);
  });

  it('rejects play, mount, docs, forced initial args and explicit test environments', async () => {
    const { render } = interactiveRender();
    await render.renderToElement({});
    render.story!.playFunction = () => {};
    expect(render.supportsArgsInteraction()).toBe(false);
    render.story!.playFunction = undefined;
    render.story!.usesMount = true;
    expect(render.supportsArgsInteraction()).toBe(false);
    render.story!.usesMount = false;
    render.viewMode = 'docs';
    expect(render.supportsArgsInteraction()).toBe(false);
    render.viewMode = 'story';
    render.renderOptions.forceInitialArgs = true;
    expect(render.supportsArgsInteraction()).toBe(false);
    render.renderOptions.forceInitialArgs = false;
    vi.stubGlobal('__vitest_browser__', true);
    expect(render.supportsArgsInteraction()).toBe(false);
  });

  it('does not reuse canvas inputs mutated by a transient renderer', async () => {
    const displayed: number[] = [];
    const canvas = vi.fn(async ({ storyContext }: RenderContext<Renderer>) => {
      if (storyContext.args.value === 9) storyContext.loaded.projectValue += 1;
      displayed.push(storyContext.loaded.projectValue);
    });
    const { render, setArgs } = interactiveRender({}, canvas);
    await render.renderToElement({});
    render.beginArgsInteraction('gesture');
    setArgs(9);
    render.updateArgsInteraction('gesture');
    await expect(render.finishArgsInteraction('gesture')).resolves.toEqual({
      status: 'completed',
      args: { value: 9 },
    });
    expect(displayed).toEqual([2, 3, 3]);
  });

  it('coalesces a gesture and runs final loaders and reports without repeating an identical canvas', async () => {
    const channel = new Channel({});
    const finished = vi.fn();
    channel.on(STORY_FINISHED, finished);
    let args = { value: 0 };
    const store = buildStore();
    vi.mocked(store.args.get).mockImplementation(() => args);
    const getStoryContext = store.getStoryContext.bind(store);
    store.getStoryContext = (story, options) => ({
      ...getStoryContext(story, options),
      args,
      reporting: new ReporterAPI(),
    });
    const loaders = vi.fn(async () => ({ projectValue: 2 }));
    const after = vi.fn();
    const story = buildStory({
      playFunction: undefined,
      hasBeforeEach: false,
      applyLoaders: loaders,
      applyAfterEach: after,
    });
    const [gate, release] = createGate();
    const rendered: number[] = [];
    const canvas = vi.fn(async ({ storyContext }: { storyContext: StoryContext }) => {
      rendered.push(storyContext.args.value);
      if (storyContext.args.value === 1) await gate;
    });
    const render = new StoryRender(
      channel,
      store,
      canvas,
      { showMain: vi.fn(), showException: vi.fn(), showError: vi.fn() },
      entry.id,
      'story',
      { autoplay: false },
      story
    );
    await render.renderToElement({});
    expect(render.beginArgsInteraction('gesture')).toBe(true);
    args = { value: 1 };
    render.updateArgsInteraction('gesture');
    await vi.waitFor(() => expect(rendered).toEqual([0, 1]));
    args = { value: 2 };
    render.updateArgsInteraction('gesture');
    args = { value: 9 };
    render.updateArgsInteraction('gesture');
    const completion = render.finishArgsInteraction('gesture');
    expect(loaders).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    release();
    await expect(completion).resolves.toEqual({ status: 'completed', args: { value: 9 } });
    expect(rendered).toEqual([0, 1, 9]);
    expect(loaders).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
    expect(finished).toHaveBeenCalledTimes(2);
  });

  it('releases a superseded automatic audit and only finishes the final revision', async () => {
    const channel = new Channel({});
    const finished = vi.fn();
    channel.on(STORY_FINISHED, finished);
    let args = { value: 0 };
    const store = buildStore();
    vi.mocked(store.args.get).mockImplementation(() => args);
    const audited: number[] = [];
    const story = buildStory({
      playFunction: undefined,
      applyAfterEach: async (context) => {
        const value = args.value;
        if (value === 0) return;
        if (value === 1) {
          await new Promise<void>((resolve) => {
            context.argsUpdateSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        if (!context.argsUpdateSignal?.aborted) audited.push(value);
      },
    });
    const render = new StoryRender(
      channel,
      store,
      vi.fn(),
      { showMain: vi.fn(), showException: vi.fn(), showError: vi.fn() },
      entry.id,
      'story',
      { autoplay: false },
      story
    );
    await render.renderToElement({});
    finished.mockClear();
    args = { value: 1 };
    const obsolete = render.rerender();
    await vi.waitFor(() => expect(render.phase).toBe('afterEach'));
    args = { value: 2 };
    const current = render.rerender();
    await expect(obsolete).resolves.toBeUndefined();
    await expect(current).resolves.toBe(args);
    expect(audited).toEqual([2]);
    expect(finished).toHaveBeenCalledOnce();
  });

  it('does run play function if passed autoplay=true', async () => {
    const story = buildStory();
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      vi.fn() as any,
      {} as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    await render.renderToElement({} as any);
    expect(story.playFunction).toHaveBeenCalled();
  });

  it('does not run play function if passed autoplay=false', async () => {
    const story = buildStory();
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      vi.fn() as any,
      {} as any,
      entry.id,
      'story',
      { autoplay: false },
      story
    );

    await render.renderToElement({} as any);
    expect(story.playFunction).not.toHaveBeenCalled();
  });

  it('only rerenders once when triggered multiple times while pending', async () => {
    // Arrange - setup StoryRender and async gate blocking applyLoaders
    const [loaderGate, openLoaderGate] = createGate();
    const renderToScreen = vi.fn();

    const story = buildStory({
      applyLoaders: vi.fn(() => loaderGate as any),
    });
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      renderToScreen,
      {} as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );
    // Arrange - render (blocked by loaders)
    render.renderToElement({} as any);
    expect(story.applyLoaders).toHaveBeenCalledOnce();
    expect(render.phase).toBe('loading');

    // Act - rerender 3x
    render.rerender();
    render.rerender();
    render.rerender();

    // Assert - still loading, not yet rendered
    expect(story.applyLoaders).toHaveBeenCalledOnce();
    expect(render.phase).toBe('loading');
    expect(renderToScreen).not.toHaveBeenCalled();

    // Act - finish loading
    openLoaderGate();

    // Assert - loaded and rendered twice, played once
    await vi.waitFor(async () => {
      expect(story.applyLoaders).toHaveBeenCalledTimes(2);
      expect(renderToScreen).toHaveBeenCalledTimes(2);
      expect(story.playFunction).toHaveBeenCalledOnce();
    });
  });

  it('keeps a queued rerender pending until its own canvas and lifecycle finish', async () => {
    const [firstCanvas, releaseFirst] = createGate();
    const [secondCanvas, releaseSecond] = createGate();
    const renderToScreen = vi
      .fn()
      .mockImplementationOnce(async () => firstCanvas)
      .mockImplementationOnce(async () => secondCanvas);
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      renderToScreen,
      {} as any,
      entry.id,
      'story',
      { autoplay: false },
      buildStory()
    );

    const initial = render.renderToElement({} as any);
    await vi.waitFor(() => expect(renderToScreen).toHaveBeenCalledOnce());
    const queued = render.rerender();
    let completed = false;
    Promise.resolve(queued).then(() => {
      completed = true;
    });
    await Promise.resolve();
    const completedBeforeFirstCanvas = completed;

    releaseFirst();
    await vi.waitFor(() => expect(renderToScreen).toHaveBeenCalledTimes(2));
    const completedBeforeSecondCanvas = completed;
    releaseSecond();
    await Promise.all([initial, queued]);
    await vi.waitFor(() => expect(render.phase).toBe('finished'));
    expect(completedBeforeFirstCanvas).toBe(false);
    expect(completedBeforeSecondCanvas).toBe(false);
    expect(completed).toBe(true);
  });

  it('settles a queued rerender without rendering it when the active render is cancelled', async () => {
    const [loaderGate, releaseLoader] = createGate();
    const story = buildStory({ applyLoaders: vi.fn(() => loaderGate as any) });
    const renderToScreen = vi.fn();
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      renderToScreen,
      {} as any,
      entry.id,
      'story',
      { autoplay: false },
      story
    );

    const initial = render.renderToElement({} as any);
    const queued = render.rerender();
    render.cancelRender();

    expect(await queued).toBeUndefined();
    releaseLoader();
    await initial;
    expect(story.applyLoaders).toHaveBeenCalledOnce();
    expect(renderToScreen).not.toHaveBeenCalled();
  });

  it('finishes the ordinary lifecycle before a rerender requested at STORY_RENDERED', async () => {
    const channel = new Channel({});
    const emit = vi.spyOn(channel, 'emit');
    const renderToScreen = vi.fn();
    const render = new StoryRender(
      channel,
      buildStore(),
      renderToScreen,
      {} as any,
      entry.id,
      'story',
      { autoplay: false },
      buildStory()
    );
    let queued: Promise<unknown> | undefined;
    channel.on(STORY_RENDERED, () => {
      if (!queued) {
        queued = render.rerender();
      }
    });

    await render.renderToElement({} as any);
    await queued;

    const events = emit.mock.calls.map(([event]) => event);
    const loadingEvents = emit.mock.calls.flatMap(([event, payload], index) =>
      event === STORY_RENDER_PHASE_CHANGED && payload.newPhase === 'loading' ? [index] : []
    );
    expect(renderToScreen).toHaveBeenCalledTimes(2);
    expect(loadingEvents).toHaveLength(2);
    expect(events.indexOf(STORY_FINISHED)).toBeLessThan(loadingEvents[1]);
  });

  it('does not complete or start a queued render until the active finite animation settles', async () => {
    const [animationFinished, finishAnimation] = createGate();
    let running = true;
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      getAnimations: () =>
        running
          ? [
              {
                playState: 'running',
                pending: false,
                effect: { getComputedTiming: () => ({ endTime: 120 }) },
                finished: animationFinished,
              },
            ]
          : [],
    });
    const channel = new Channel({});
    const emit = vi.spyOn(channel, 'emit');
    const renderToScreen = vi.fn();
    const render = new StoryRender(
      channel,
      buildStore(),
      renderToScreen,
      { showMain: vi.fn(), showError: vi.fn(), showException: vi.fn() },
      entry.id,
      'story',
      { autoplay: false },
      buildStory()
    );

    const initial = render.renderToElement({});
    await vi.waitFor(() => expect(render.phase).toBe('completing'));
    const queued = render.rerender();
    expect(renderToScreen).toHaveBeenCalledOnce();
    expect(emit.mock.calls.some(([event]) => event === STORY_FINISHED)).toBe(false);

    running = false;
    finishAnimation();
    await Promise.all([initial, queued]);

    expect(renderToScreen).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.filter(([event]) => event === STORY_FINISHED)).toHaveLength(2);
  });

  it('cancels animation settling and queued work without reporting a rendered revision', async () => {
    const [animationFinished] = createGate();
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      getAnimations: () => [
        {
          playState: 'running',
          pending: false,
          effect: { getComputedTiming: () => ({ endTime: 120 }) },
          finished: animationFinished,
        },
      ],
    });
    const channel = new Channel({});
    const emit = vi.spyOn(channel, 'emit');
    const renderToScreen = vi.fn();
    const render = new StoryRender(
      channel,
      buildStore(),
      renderToScreen,
      { showMain: vi.fn(), showError: vi.fn(), showException: vi.fn() },
      entry.id,
      'story',
      { autoplay: false },
      buildStory()
    );

    const initial = render.renderToElement({});
    await vi.waitFor(() => expect(render.phase).toBe('completing'));
    const queued = render.rerender();
    render.cancelRender();

    expect(await queued).toBeUndefined();
    await initial;
    expect(renderToScreen).toHaveBeenCalledOnce();
    expect(emit.mock.calls.some(([event]) => event === STORY_RENDERED)).toBe(false);
    expect(emit.mock.calls.some(([event]) => event === STORY_FINISHED)).toBe(false);
  });

  it('calls mount if play function does not destructure mount', async () => {
    const story = buildStory({
      playFunction: () => {},
    });
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      vi.fn() as any,
      {} as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    await render.renderToElement({} as any);
    expect(mountSpy).toHaveBeenCalledOnce();
  });

  it('does not call mount twice if mount called in play function', async () => {
    const story = buildStory({
      usesMount: true,
      playFunction: async ({ mount }) => {
        await mount();
      },
    });
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      vi.fn() as any,
      {} as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    await render.renderToElement({} as any);
    expect(mountSpy).toHaveBeenCalledOnce();
  });

  it('errors if play function calls mount without destructuring', async () => {
    const story = buildStory({
      playFunction: async (context) => {
        await context.mount();
      },
    });
    const view = { showException: vi.fn() };
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      vi.fn() as any,
      view as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    await render.renderToElement({} as any);
    expect(view.showException).toHaveBeenCalled();
  });

  it('errors if play function destructures mount but does not call it', async () => {
    const story = buildStory({
      usesMount: true,
      playFunction: async ({ mount }) => {
        // forget to call mount
      },
    });
    const view = { showException: vi.fn() };
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      vi.fn() as any,
      view as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    await render.renderToElement({} as any);
    expect(view.showException).toHaveBeenCalled();
  });

  it('enters rendering phase during play if play function calls mount', async () => {
    const actualMount = vi.fn(async (context) => {
      await context.renderToCanvas();
      expect(render.phase).toBe('rendering');
      return context.canvas;
    });
    const story = buildStory({
      mount: (context) => () => actualMount(context) as any,
      usesMount: true,
      playFunction: async ({ mount }) => {
        expect(render.phase).toBe('loading');
        await mount();
        expect(render.phase).toBe('playing');
      },
    });
    const render = new StoryRender(
      new Channel({}),
      buildStore(),
      vi.fn(() => {
        expect(render.phase).toBe('rendering');
      }) as any,
      {} as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    await render.renderToElement({} as any);
    expect(actualMount).toHaveBeenCalled();
  });

  it('should handle the "finished" phase correctly when the story finishes successfully', async () => {
    // Arrange - setup StoryRender and async gate blocking finished phase
    const [finishGate, resolveFinishGate] = createGate();
    const story = buildStory({
      playFunction: vi.fn(async () => {
        await finishGate;
      }),
    });
    const store = buildStore();

    const channel = new Channel({});
    const emitSpy = vi.spyOn(channel, 'emit');

    const render = new StoryRender(
      channel,
      store,
      vi.fn() as any,
      {} as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    // Act - render, resolve finish gate, teardown
    render.renderToElement({} as any);
    await tick(); // go from 'loading' to 'rendering' phase
    resolveFinishGate();
    await tick(); // go from 'rendering' to 'finished' phase
    render.teardown();

    // Assert - ensure finished phase is handled correctly
    expect(render.phase).toBe('finished');
    expect(emitSpy).toHaveBeenCalledWith(STORY_FINISHED, {
      reporters: [],
      status: 'success',
      storyId: 'id',
    });
  });

  it('should handle the "finished" phase correctly when the story throws an error', async () => {
    // Arrange - setup StoryRender and async gate blocking finished phase
    const [finishGate, rejectFinishGate] = createGate();
    const error = new Error('Test error');
    const story = buildStory({
      parameters: {},
      playFunction: vi.fn(async () => {
        await finishGate;
        throw error;
      }),
    });
    const store = buildStore();

    const channel = new Channel({});
    const emitSpy = vi.spyOn(channel, 'emit');

    const render = new StoryRender(
      channel,
      store,
      vi.fn() as any,
      {
        showException: vi.fn(),
      } as any,
      entry.id,
      'story',
      { autoplay: true },
      story
    );

    // Act - render, reject finish gate, teardown
    render.renderToElement({} as any);
    await tick(); // go from 'loading' to 'rendering' phase
    rejectFinishGate();
    await tick(); // go from 'rendering' to 'finished' phase
    render.teardown();

    // Assert - ensure finished phase is handled correctly
    expect(render.phase).toBe('finished');
    expect(emitSpy).toHaveBeenCalledWith(STORY_FINISHED, {
      reporters: [],
      status: 'error',
      storyId: 'id',
    });
  });

  describe('teardown', () => {
    it('throws PREPARE_ABORTED if torndown during prepare', async () => {
      const [importGate, openImportGate] = createGate();
      const mockStore = buildStore({
        loadStory: vi.fn(async () => {
          await importGate;
          return {};
        }) as any,
      });

      const render = new StoryRender(
        new Channel({}),
        mockStore,
        vi.fn(),
        {} as any,
        entry.id,
        'story'
      );

      const preparePromise = render.prepare();

      render.teardown();

      openImportGate();

      await expect(preparePromise).rejects.toThrowError(PREPARE_ABORTED);
    });

    it('reloads the page when tearing down during loading', async () => {
      // Arrange - setup StoryRender and async gate blocking applyLoaders
      const [loaderGate] = createGate();
      const story = buildStory({
        applyLoaders: vi.fn(() => loaderGate as any),
      });
      const store = buildStore();
      const render = new StoryRender(
        new Channel({}),
        store,
        vi.fn() as any,
        {} as any,
        entry.id,
        'story',
        { autoplay: true },
        story
      );

      // Act - render (blocked by loaders), teardown
      render.renderToElement({} as any);
      expect(story.applyLoaders).toHaveBeenCalledOnce();
      expect(render.phase).toBe('loading');
      render.teardown();

      // Assert - window is reloaded
      await vi.waitFor(() => {
        expect(window.location.reload).toHaveBeenCalledOnce();
        expect(store.cleanupStory).toHaveBeenCalledOnce();
      });
    });

    it('reloads the page when tearing down during rendering', async () => {
      // Arrange - setup StoryRender and async gate blocking renderToScreen
      const [renderGate] = createGate();
      const story = buildStory();
      const store = buildStore();
      const renderToScreen = vi.fn(() => renderGate);

      const render = new StoryRender(
        new Channel({}),
        store,
        renderToScreen as any,
        {} as any,
        entry.id,
        'story',
        { autoplay: true },
        story
      );

      // Act - render (blocked by renderToScreen), teardown
      render.renderToElement({} as any);
      await tick(); // go from 'loading' to 'rendering' phase
      expect(renderToScreen).toHaveBeenCalledOnce();
      expect(render.phase).toBe('rendering');
      render.teardown();

      // Assert - window is reloaded
      await vi.waitFor(() => {
        expect(window.location.reload).toHaveBeenCalledOnce();
        expect(store.cleanupStory).toHaveBeenCalledOnce();
      });
    });

    it('reloads the page when tearing down during playing', async () => {
      // Arrange - setup StoryRender and async gate blocking playing
      const [playGate] = createGate();
      const story = buildStory({
        playFunction: vi.fn(() => playGate as any),
      });
      const store = buildStore();

      const render = new StoryRender(
        new Channel({}),
        store,
        vi.fn() as any,
        {} as any,
        entry.id,
        'story',
        { autoplay: true },
        story
      );

      // Act - render (blocked by playFn), teardown
      render.renderToElement({} as any);
      await tick(); // go from 'loading' to 'beforeEach' phase
      await tick(); // go from 'beforeEach' to 'playing' phase
      expect(story.playFunction).toHaveBeenCalledOnce();
      expect(render.phase).toBe('playing');
      render.teardown();

      // Assert - window is reloaded
      await vi.waitFor(() => {
        expect(window.location.reload).toHaveBeenCalledOnce();
        expect(store.cleanupStory).toHaveBeenCalledOnce();
      });
    });

    it('reloads the page when remounting during loading', async () => {
      // Arrange - setup StoryRender and async gate blocking applyLoaders
      const [loaderGate] = createGate();
      const story = buildStory({
        applyLoaders: vi.fn(() => loaderGate as any),
      });
      const store = buildStore();

      const render = new StoryRender(
        new Channel({}),
        store,
        vi.fn() as any,
        {} as any,
        entry.id,
        'story',
        { autoplay: true },
        story
      );

      // Act - render, blocked by loaders
      render.renderToElement({} as any);
      expect(story.applyLoaders).toHaveBeenCalledOnce();
      expect(render.phase).toBe('loading');
      // Act - remount
      render.remount();

      // Assert - window is reloaded
      await vi.waitFor(() => {
        expect(window.location.reload).toHaveBeenCalledOnce();
        expect(store.cleanupStory).toHaveBeenCalledOnce();
      });
    });
  });
});
