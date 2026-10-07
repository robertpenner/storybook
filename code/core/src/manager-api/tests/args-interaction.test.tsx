// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { Channel } from 'storybook/internal/channels';
import {
  ARGS_INTERACTION_BEGIN,
  ARGS_INTERACTION_CANCEL,
  ARGS_INTERACTION_FINISH,
  ARGS_INTERACTION_RESULT,
  ARGS_INTERACTION_UPDATE,
  STORY_CHANGED,
  UPDATE_STORY_ARGS,
} from 'storybook/internal/core-events';
import { logger } from 'storybook/internal/client-logger';
import type { API_StoryEntry } from 'storybook/internal/types';

import { init as initStories } from '../modules/stories.ts';
import type { ModuleArgs } from '../lib/types.tsx';
import { type API, ManagerContext, type State, useArgs, useArgsInteraction } from '../root.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const story: API_StoryEntry & { argsInteraction?: boolean } = {
  id: 'component--story',
  type: 'story',
  subtype: 'story',
  parent: 'component',
  title: 'Component',
  name: 'Story',
  exportName: 'Story',
  importPath: './Component.stories.tsx',
  depth: 2,
  tags: [],
  prepared: true,
  argsInteraction: true,
  args: { amount: 20 },
};

function setup(entry = story, viewMode = 'story') {
  const channel = new Channel({});
  const updateStoryArgs = vi.fn();
  const api = {
    getCurrentStoryData: () => entry,
    getChannel: () => channel,
    updateStoryArgs,
  } as unknown as API;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ManagerContext.Provider value={{ api, state: { viewMode } as State }}>
      {children}
    </ManagerContext.Provider>
  );
  return { channel, api, wrapper, updateStoryArgs };
}

describe('useArgsInteraction', () => {
  it('delivers range updates and exact final completion through the manager channel', async () => {
    const { channel, wrapper } = setup();
    const begin = vi.fn();
    const update = vi.fn();
    const finish = vi.fn();
    channel.on(ARGS_INTERACTION_BEGIN, begin);
    channel.on(ARGS_INTERACTION_UPDATE, update);
    channel.on(ARGS_INTERACTION_FINISH, finish);
    const { result } = renderHook(useArgsInteraction, { wrapper });

    expect(result.current?.begin()).toBe(true);
    result.current?.update({ amount: 47 });
    const completion = result.current!.finish({ amount: 63 });
    const { interactionId } = begin.mock.calls[0][0];
    expect(update).toHaveBeenCalledWith({
      storyId: story.id,
      interactionId,
      updatedArgs: { amount: 47 },
    });
    expect(finish).toHaveBeenCalledWith({
      storyId: story.id,
      interactionId,
      updatedArgs: { amount: 63 },
    });
    act(() => {
      channel.emit(ARGS_INTERACTION_RESULT, {
        storyId: story.id,
        interactionId,
        status: 'completed',
        args: { amount: 63 },
      });
    });
    await expect(completion).resolves.toEqual({ status: 'completed', args: { amount: 63 } });
  });

  it.each([
    { argsInteraction: undefined },
    { argsInteraction: false },
    { argsInteraction: 'true' },
    { prepared: false },
    { refId: 'remote' },
    { subtype: 'test' },
    { type: 'docs' },
  ])('preserves ordinary Controls updates for unsupported entries: %j', (override) => {
    const entry = { ...story, ...override } as typeof story;
    const { wrapper, updateStoryArgs } = setup(entry);
    const { result } = renderHook(() => [useArgsInteraction(), useArgs()] as const, { wrapper });
    expect(result.current[0]).toBeUndefined();
    result.current[1][1]({ amount: 42 });
    expect(updateStoryArgs).toHaveBeenCalledExactlyOnceWith(entry, { amount: 42 });
  });

  it('does not start an interaction in the docs view', () => {
    const { wrapper } = setup(story, 'docs');
    const { result } = renderHook(useArgsInteraction, { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('retains the current client when args acknowledgements update the entry', () => {
    const { wrapper, api } = setup();
    const { result, rerender } = renderHook(useArgsInteraction, { wrapper });
    const original = result.current;
    api.getCurrentStoryData = () => ({ ...story, args: { amount: 72 } });
    rerender();
    expect(result.current).toBe(original);
    expect(result.current!.begin()).toBe(true);
  });

  it('disposes an active client when capability is revoked', async () => {
    const { wrapper, api, channel } = setup();
    const cancel = vi.fn();
    channel.on(ARGS_INTERACTION_CANCEL, cancel);
    const { result, rerender } = renderHook(useArgsInteraction, { wrapper });
    const previous = result.current!;
    previous.begin();
    const completion = previous.finish({ amount: 61 });
    api.getCurrentStoryData = () => ({ ...story, argsInteraction: false });
    rerender();
    expect(result.current).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(completion).resolves.toEqual({ status: 'cancelled' });
    expect(previous.begin()).toBe(false);
  });

  it('routes unsupported remote range updates through the existing target option', () => {
    const channel = new Channel({});
    const update = vi.fn();
    channel.on(UPDATE_STORY_ARGS, update);
    const provider = { channel, getConfig: () => ({}) };
    const store = {
      getState: () => ({ index: {}, filters: {} }),
      setState: vi.fn(),
    };
    const { api } = initStories({
      provider,
      store,
      fullAPI: {},
      state: {},
    } as unknown as ModuleArgs);
    const remote = { ...story, refId: 'remote' };
    api.updateStoryArgs(remote, { amount: 74 });
    expect(update).toHaveBeenCalledExactlyOnceWith({
      storyId: story.id,
      updatedArgs: { amount: 74 },
      options: { target: 'remote' },
    });
  });

  it('keeps updates delivered while a preceding finish is pending', async () => {
    const { channel, wrapper } = setup();
    const begin = vi.fn();
    const ordinary = vi.fn();
    channel.on(ARGS_INTERACTION_BEGIN, begin);
    channel.on(UPDATE_STORY_ARGS, ordinary);
    const { result } = renderHook(useArgsInteraction, { wrapper });
    result.current!.begin();
    const completion = result.current!.finish({ amount: 40 });
    expect(result.current!.begin()).toBe(false);
    result.current!.update({ amount: 70 });
    await expect(result.current!.finish({ amount: 71 })).resolves.toEqual({
      status: 'unsupported',
    });
    expect(ordinary.mock.calls.map(([payload]) => payload.updatedArgs)).toEqual([
      { amount: 70 },
      { amount: 71 },
    ]);
    channel.emit(ARGS_INTERACTION_RESULT, {
      storyId: story.id,
      interactionId: begin.mock.calls[0][0].interactionId,
      status: 'cancelled',
    });
    await expect(completion).resolves.toEqual({ status: 'cancelled' });
  });

  it('cancels the owned interaction and removes listeners on unmount', async () => {
    const { channel, wrapper } = setup();
    const cancel = vi.fn();
    channel.on(ARGS_INTERACTION_CANCEL, cancel);
    const { result, unmount } = renderHook(useArgsInteraction, { wrapper });
    const client = result.current!;
    client.begin();
    const completion = client.finish({ amount: 53 });
    unmount();
    await expect(completion).resolves.toEqual({ status: 'cancelled' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(channel.listeners(ARGS_INTERACTION_RESULT)).toHaveLength(0);
    expect(client.begin()).toBe(false);
  });

  it('prevents old story updates after navigation and starts a client for the new story', async () => {
    const { channel, wrapper, api } = setup();
    const update = vi.fn();
    channel.on(ARGS_INTERACTION_UPDATE, update);
    const { result, rerender } = renderHook(useArgsInteraction, { wrapper });
    const previous = result.current!;
    previous.begin();
    const completion = previous.finish({ amount: 61 });
    act(() => {
      channel.emit(STORY_CHANGED);
      api.getCurrentStoryData = () => ({ ...story, id: 'component--next' });
      rerender();
    });
    previous.update({ amount: 90 });
    expect(update).not.toHaveBeenCalled();
    await expect(completion).resolves.toEqual({ status: 'cancelled' });
    expect(result.current!.begin()).toBe(true);
    result.current!.update({ amount: 32 });
    expect(update.mock.calls[0][0].storyId).toBe('component--next');
  });

  it('reports a typed failed completion through the client logger', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { channel, wrapper } = setup();
    const begin = vi.fn();
    channel.on(ARGS_INTERACTION_BEGIN, begin);
    const { result } = renderHook(useArgsInteraction, { wrapper });
    result.current!.begin();
    const completion = result.current!.finish({ amount: 83 });
    channel.emit(ARGS_INTERACTION_RESULT, {
      storyId: story.id,
      interactionId: begin.mock.calls[0][0].interactionId,
      status: 'failed',
    });
    await expect(completion).resolves.toEqual({ status: 'failed' });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Args interaction failed for story 'component--story'."
    );
  });
});
