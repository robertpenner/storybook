import type { Channel } from 'storybook/internal/channels';
import {
  ARGS_INTERACTION_BEGIN,
  ARGS_INTERACTION_CANCEL,
  ARGS_INTERACTION_FINISH,
  ARGS_INTERACTION_RESULT,
  ARGS_INTERACTION_UPDATE,
  CHANNEL_WS_DISCONNECT,
  STORY_CHANGED,
  STORY_HOT_UPDATED,
  UPDATE_STORY_ARGS,
  type ArgsInteractionResult,
  type ArgsInteractionResultPayload,
} from '../core-events/index.ts';
import type { Args, StoryId } from 'storybook/internal/types';

// An undefined update removes a key from ArgsStore.
export function argsUpdateMatches<TArgs extends Args>(
  args: TArgs,
  updatedArgs: Partial<TArgs>
): boolean {
  return Object.entries(updatedArgs).every(([key, value]) =>
    value === undefined ? !Object.hasOwn(args, key) : Object.is(args[key], value)
  );
}

export interface ArgsInteraction<TArgs extends Args = Args> {
  begin(): boolean;
  update(updatedArgs: Partial<TArgs>): void;
  finish(updatedArgs?: Partial<TArgs>): Promise<ArgsInteractionResult<TArgs>>;
  cancel(): Promise<ArgsInteractionResult<TArgs>>;
}

let nextInteractionId = 0;

/** Create an args gesture client. Dispose it when its owning story or channel is removed. */
export function createArgsInteraction<TArgs extends Args = Args>({
  channel,
  storyId,
  supported,
}: {
  channel: Channel;
  storyId: StoryId;
  supported: boolean;
}): ArgsInteraction<TArgs> & { dispose(): void } {
  let disposed = false;
  let settledResult: ArgsInteractionResult<TArgs> | undefined;
  let session:
    | {
        interactionId: string;
        promise: Promise<ArgsInteractionResult<TArgs>>;
        resolve: (result: ArgsInteractionResult<TArgs>) => void;
        phase: 'active' | 'finishing' | 'cancelling';
        updatedArgs: Partial<TArgs>;
      }
    | undefined;

  const settle = (result: ArgsInteractionResult<TArgs>) => {
    settledResult = result;
    const previous = session;
    session = undefined;
    channel.removeListener(ARGS_INTERACTION_RESULT, onResult);
    channel.removeListener(STORY_CHANGED, onStoryChanged);
    channel.removeListener(STORY_HOT_UPDATED, onStoryHotUpdated);
    channel.removeListener(CHANNEL_WS_DISCONNECT, onStoryChanged);
    previous?.resolve(result);
  };
  const onResult = (payload: ArgsInteractionResultPayload<TArgs>) => {
    if (payload.storyId !== storyId || payload.interactionId !== session?.interactionId) return;
    const fallbackArgs =
      payload.status === 'unsupported' && session?.phase !== 'cancelling'
        ? session?.updatedArgs
        : undefined;
    settle(
      payload.status === 'completed'
        ? { status: 'completed', args: payload.args }
        : { status: payload.status }
    );
    if (fallbackArgs && Object.keys(fallbackArgs).length && !disposed) {
      updateOrdinary(fallbackArgs);
    }
  };
  const onStoryChanged = () => {
    disposed = true;
    settle({ status: 'cancelled' });
  };
  const onStoryHotUpdated = () => settle({ status: 'cancelled' });
  const updateOrdinary = (updatedArgs: Partial<TArgs>) => {
    if (session?.phase === 'finishing') {
      session.updatedArgs = { ...session.updatedArgs, ...updatedArgs };
    }
    if (settledResult?.status === 'completed') settledResult = undefined;
    channel.emit(UPDATE_STORY_ARGS, { storyId, updatedArgs });
  };

  return {
    begin() {
      if (disposed || !supported) return false;
      if (session) return session.phase === 'active';
      settledResult = undefined;
      let resolve!: (result: ArgsInteractionResult<TArgs>) => void;
      const promise = new Promise<ArgsInteractionResult<TArgs>>((done) => {
        resolve = done;
      });
      session = {
        interactionId: `${Date.now()}-${++nextInteractionId}-${Math.random().toString(36).slice(2)}`,
        promise,
        resolve,
        phase: 'active',
        updatedArgs: {},
      };
      channel.on(ARGS_INTERACTION_RESULT, onResult);
      channel.on(STORY_CHANGED, onStoryChanged);
      channel.on(STORY_HOT_UPDATED, onStoryHotUpdated);
      channel.on(CHANNEL_WS_DISCONNECT, onStoryChanged);
      channel.emit(ARGS_INTERACTION_BEGIN, { storyId, interactionId: session.interactionId });
      return true;
    },
    update(updatedArgs) {
      if (disposed) return;
      if (!session || session.phase !== 'active') {
        updateOrdinary(updatedArgs);
      } else {
        session.updatedArgs = { ...session.updatedArgs, ...updatedArgs };
        channel.emit(ARGS_INTERACTION_UPDATE, {
          storyId,
          interactionId: session.interactionId,
          updatedArgs,
        });
      }
    },
    finish(updatedArgs) {
      if (disposed) return Promise.resolve({ status: 'cancelled' });
      if (!session) {
        if (settledResult && settledResult.status !== 'unsupported') {
          const result = settledResult;
          if (
            result.status !== 'completed' ||
            !updatedArgs ||
            argsUpdateMatches(result.args, updatedArgs)
          ) {
            return Promise.resolve(result);
          }
        }
        if (updatedArgs) updateOrdinary(updatedArgs);
        return Promise.resolve({ status: 'unsupported' });
      }
      const current = session;
      if (
        current.phase !== 'active' &&
        updatedArgs &&
        Object.entries(updatedArgs).some(
          ([key, value]) =>
            !Object.hasOwn(current.updatedArgs, key) || !Object.is(current.updatedArgs[key], value)
        )
      ) {
        updateOrdinary(updatedArgs);
        return Promise.resolve({ status: 'unsupported' });
      }
      if (current.phase === 'active') {
        current.phase = 'finishing';
        current.updatedArgs = { ...current.updatedArgs, ...updatedArgs };
        channel.emit(ARGS_INTERACTION_FINISH, {
          storyId,
          interactionId: current.interactionId,
          updatedArgs,
        });
      }
      return current.promise;
    },
    cancel() {
      if (!session) {
        return Promise.resolve(settledResult ?? { status: disposed ? 'cancelled' : 'unsupported' });
      }
      const current = session;
      current.phase = 'cancelling';
      channel.emit(ARGS_INTERACTION_CANCEL, { storyId, interactionId: current.interactionId });
      return current.promise;
    },
    dispose() {
      if (session) {
        channel.emit(ARGS_INTERACTION_CANCEL, { storyId, interactionId: session.interactionId });
      }
      onStoryChanged();
    },
  };
}
