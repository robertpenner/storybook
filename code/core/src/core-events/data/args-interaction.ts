import type { Args, StoryId } from 'storybook/internal/types';

export interface ArgsInteractionIdentity {
  storyId: StoryId;
  interactionId: string;
}

export interface ArgsInteractionUpdatePayload<
  TArgs extends Args = Args,
> extends ArgsInteractionIdentity {
  updatedArgs: Partial<TArgs>;
}

export interface ArgsInteractionFinishPayload<
  TArgs extends Args = Args,
> extends ArgsInteractionIdentity {
  updatedArgs?: Partial<TArgs>;
}

export type ArgsInteractionResult<TArgs extends Args = Args> =
  | { status: 'completed'; args: TArgs }
  | { status: 'failed' | 'cancelled' | 'unsupported' };

export type ArgsInteractionResultPayload<TArgs extends Args = Args> = ArgsInteractionIdentity &
  ArgsInteractionResult<TArgs>;
