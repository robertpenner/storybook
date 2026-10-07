import { describe, expect, it } from 'vitest';

import { Channel } from 'storybook/internal/channels';
import {
  ARGS_INTERACTION_BEGIN,
  ARGS_INTERACTION_FINISH,
  ARGS_INTERACTION_RESULT,
  STORY_CHANGED,
  UPDATE_STORY_ARGS,
} from '../core-events/index.ts';

import { createArgsInteraction } from './args-interaction.ts';

describe('createArgsInteraction', () => {
  it('treats an undefined patch as removing an existing undefined key', async () => {
    const channel = new Channel({});
    const updates: unknown[] = [];
    channel.on(UPDATE_STORY_ARGS, (payload) => updates.push(payload));
    channel.on(ARGS_INTERACTION_FINISH, ({ storyId, interactionId }) => {
      channel.emit(ARGS_INTERACTION_RESULT, {
        storyId,
        interactionId,
        status: 'completed',
        args: { value: 9, empty: undefined },
      });
    });
    const client = createArgsInteraction<{ value: number; empty?: number }>({
      channel,
      storyId: 'story',
      supported: true,
    });
    client.begin();
    await client.finish({ value: 9 });
    const removing = client.finish({ empty: undefined });
    expect(updates).toEqual([{ storyId: 'story', updatedArgs: { empty: undefined } }]);
    await expect(removing).resolves.toEqual({ status: 'unsupported' });
    client.dispose();
  });

  it.each(['update', 'finish'] as const)(
    'uses ordinary args for a new %s while the preceding finish is pending',
    async (operation) => {
      const channel = new Channel({});
      const updates: unknown[] = [];
      let identity = { storyId: 'story', interactionId: '' };
      channel.on(ARGS_INTERACTION_BEGIN, (payload) => {
        identity = payload;
      });
      channel.on(UPDATE_STORY_ARGS, (payload) => {
        updates.push(payload);
        channel.emit(ARGS_INTERACTION_RESULT, { ...identity, status: 'cancelled' });
      });
      const client = createArgsInteraction<{ value: number }>({
        channel,
        storyId: 'story',
        supported: true,
      });
      client.begin();
      client.update({ value: 9 });
      const preceding = client.finish({ value: 9 });
      expect(client.finish({ value: 9 })).toBe(preceding);
      expect(client.begin()).toBe(false);
      const next = operation === 'finish' ? client.finish({ value: 11 }) : undefined;
      if (operation === 'update') client.update({ value: 11 });
      expect(updates).toEqual([{ storyId: 'story', updatedArgs: { value: 11 } }]);
      await expect(preceding).resolves.toEqual({ status: 'cancelled' });
      if (next) await expect(next).resolves.toEqual({ status: 'unsupported' });
      client.dispose();
    }
  );

  it.each(['update', 'finish'] as const)(
    'does not reuse completed args after a new ordinary %s',
    async (operation) => {
      const channel = new Channel({});
      const updates: unknown[] = [];
      channel.on(UPDATE_STORY_ARGS, (payload) => updates.push(payload));
      channel.on(ARGS_INTERACTION_FINISH, ({ storyId, interactionId }) => {
        channel.emit(ARGS_INTERACTION_RESULT, {
          storyId,
          interactionId,
          status: 'completed',
          args: { value: 9 },
        });
      });
      const client = createArgsInteraction<{ value: number }>({
        channel,
        storyId: 'story',
        supported: true,
      });
      client.begin();
      await expect(client.finish({ value: 9 })).resolves.toEqual({
        status: 'completed',
        args: { value: 9 },
      });
      await expect(client.finish({ value: 9 })).resolves.toEqual({
        status: 'completed',
        args: { value: 9 },
      });
      expect(updates).toEqual([]);
      if (operation === 'update') client.update({ value: 11 });
      await expect(
        client.finish(operation === 'finish' ? { value: 11 } : undefined)
      ).resolves.toEqual({
        status: 'unsupported',
      });
      expect(updates).toEqual([{ storyId: 'story', updatedArgs: { value: 11 } }]);
      client.dispose();
    }
  );

  it('retains automatic cancellation for finish and permits ordinary updates without an active gesture', async () => {
    const channel = new Channel({});
    const updates: unknown[] = [];
    channel.on(UPDATE_STORY_ARGS, (payload) => updates.push(payload));
    channel.on(ARGS_INTERACTION_BEGIN, ({ storyId, interactionId }) => {
      channel.emit(ARGS_INTERACTION_RESULT, { storyId, interactionId, status: 'cancelled' });
    });
    const client = createArgsInteraction<{ value: number }>({
      channel,
      storyId: 'story',
      supported: true,
    });
    client.begin();
    client.update({ value: 3 });
    await expect(client.finish({ value: 9 })).resolves.toEqual({ status: 'cancelled' });
    expect(updates).toEqual([{ storyId: 'story', updatedArgs: { value: 3 } }]);
    client.dispose();
  });

  it('keeps ordinary updates and reports unsupported for an older preview', async () => {
    const channel = new Channel({});
    const updates: unknown[] = [];
    channel.on(UPDATE_STORY_ARGS, (payload) => updates.push(payload));
    const client = createArgsInteraction<{ value: number }>({
      channel,
      storyId: 'story',
      supported: false,
    });
    expect(client.begin()).toBe(false);
    client.update({ value: 3 });
    await expect(client.finish({ value: 7 })).resolves.toEqual({ status: 'unsupported' });
    expect(updates).toEqual([
      { storyId: 'story', updatedArgs: { value: 3 } },
      { storyId: 'story', updatedArgs: { value: 7 } },
    ]);
    client.dispose();
  });

  it('settles pending completion on navigation and disposal', async () => {
    const channel = new Channel({});
    const client = createArgsInteraction({
      channel,
      storyId: 'story',
      supported: true,
    });
    client.begin();
    const completion = client.finish();
    channel.emit(STORY_CHANGED, 'other');
    await expect(completion).resolves.toEqual({ status: 'cancelled' });
    expect(channel.listenerCount(ARGS_INTERACTION_RESULT)).toBe(0);
    client.dispose();
    expect(channel.listenerCount(STORY_CHANGED)).toBe(0);
  });

  it('registers completion before emitting finish and ignores other interactions', async () => {
    const channel = new Channel({});
    const client = createArgsInteraction<{ value: number }>({
      channel,
      storyId: 'story',
      supported: true,
    });
    channel.on(ARGS_INTERACTION_FINISH, ({ storyId, interactionId }) => {
      channel.emit(ARGS_INTERACTION_RESULT, {
        storyId,
        interactionId: 'obsolete',
        status: 'completed',
        args: { value: 1 },
      });
      channel.emit(ARGS_INTERACTION_RESULT, {
        storyId,
        interactionId,
        status: 'completed',
        args: { value: 9 },
      });
    });
    expect(client.begin()).toBe(true);
    await expect(client.finish({ value: 9 })).resolves.toEqual({
      status: 'completed',
      args: { value: 9 },
    });
    expect(channel.listenerCount(ARGS_INTERACTION_RESULT)).toBe(0);
    expect(channel.listenerCount(STORY_CHANGED)).toBe(0);
    client.dispose();
  });
});
