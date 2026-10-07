import type { FC } from 'react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Link } from 'storybook/internal/components';
import type { ArgsInteraction } from 'storybook/preview-api';

import {
  BooleanControl,
  ColorControl,
  DateControl,
  FilesControl,
  NumberControl,
  ObjectControl,
  OptionsControl,
  RangeControl,
  TextControl,
} from '../../controls';
import type { ArgType, Args } from './types';

export interface ArgControlProps {
  row: ArgType;
  arg: any;
  updateArgs: (args: Args) => void;
  argsInteraction?: ArgsInteraction;
  resetVersion?: number;
  isRequired: boolean;
  storyId?: string;
  controlsId?: string;
}

const Controls: Record<string, FC<any>> = {
  array: ObjectControl,
  object: ObjectControl,
  boolean: BooleanControl,
  color: ColorControl,
  date: DateControl,
  number: NumberControl,
  check: OptionsControl,
  'inline-check': OptionsControl,
  radio: OptionsControl,
  'inline-radio': OptionsControl,
  select: OptionsControl,
  'multi-select': OptionsControl,
  range: RangeControl,
  text: TextControl,
  file: FilesControl,
};

const NoControl = () => <>-</>;

export const ArgControl: FC<ArgControlProps> = ({
  row,
  arg,
  updateArgs,
  argsInteraction,
  resetVersion,
  isRequired,
  storyId,
  controlsId,
}) => {
  const { key, control } = row;

  const [isFocused, setFocused] = useState(false);
  // box because arg can be a fn (e.g. actions) and useState calls fn's
  const [boxedValue, setBoxedValue] = useState({ value: arg });
  const gestureVersion = useRef(0);
  const isFinishing = useRef(false);
  const isInputFocused = useRef(false);
  const isContinuousGesture = useRef(false);

  useEffect(() => {
    gestureVersion.current += 1;
    isFinishing.current = false;
    isInputFocused.current = false;
    isContinuousGesture.current = false;
    setFocused(false);
  }, [resetVersion]);

  useEffect(
    () => () => {
      gestureVersion.current += 1;
    },
    []
  );

  useEffect(() => {
    if (!isFocused) {
      setBoxedValue({ value: arg });
    }
  }, [isFocused, arg]);

  const onChange = useCallback(
    (argVal: any) => {
      setBoxedValue({ value: argVal });
      if (control?.type === 'range' && argsInteraction && isContinuousGesture.current) {
        argsInteraction.update({ [key]: argVal });
      } else {
        updateArgs({ [key]: argVal });
      }
      return argVal;
    },
    [updateArgs, argsInteraction, control?.type, key]
  );

  const onBlur = useCallback(() => {
    isInputFocused.current = false;
    if (!isFinishing.current) {
      setFocused(false);
    }
  }, []);
  const onFocus = useCallback(() => {
    isInputFocused.current = true;
    setFocused(true);
  }, []);

  if (!control || control.disable) {
    const canBeSetup = control?.disable !== true && row?.type?.name !== 'function';
    if (!canBeSetup) {
      return <NoControl />;
    }
    // Both nodes are always rendered; the parent row toggles their visibility with CSS on
    // :hover and :focus-within, so the link stays reachable for keyboard users.
    return (
      <>
        <span className="sbdocs sbdocs-argcontrol-setup">
          <Link
            href="https://storybook.js.org/docs/essentials/controls?ref=ui"
            target="_blank"
            withArrow
          >
            Setup controls
          </Link>
        </span>
        <span className="sbdocs sbdocs-argcontrol-placeholder">
          <NoControl />
        </span>
      </>
    );
  }
  // row.name is a display name and not a suitable DOM input id or name - i might contain whitespace etc.
  // row.key is a hash key and therefore a much safer choice
  const props = {
    name: key,
    storyId,
    controlsId,
    argType: row,
    value: boxedValue.value,
    required: isRequired,
    onChange,
    onBlur,
    onFocus,
    ...(control.type === 'range' && {
      resetVersion,
      onGestureStart: () => {
        gestureVersion.current += 1;
        isFinishing.current = false;
        isInputFocused.current = true;
        setFocused(true);
        isContinuousGesture.current = argsInteraction?.begin() === true;
      },
      onGestureFinish: async (value: number | null | undefined) => {
        if (!argsInteraction || !isContinuousGesture.current) {
          return;
        }
        isContinuousGesture.current = false;
        const version = gestureVersion.current;
        isFinishing.current = true;
        const result = await argsInteraction.finish({ [key]: value });
        if (version === gestureVersion.current) {
          isFinishing.current = false;
          if (result.status === 'completed') {
            setBoxedValue({ value: result.args[key] });
          }
          if (!isInputFocused.current) {
            setFocused(false);
          }
        }
      },
      onGestureCancel: (value: number | null | undefined) => {
        gestureVersion.current += 1;
        isFinishing.current = false;
        isInputFocused.current = false;
        setBoxedValue({ value });
        setFocused(false);
        if (argsInteraction && isContinuousGesture.current) {
          isContinuousGesture.current = false;
          void argsInteraction.cancel();
        } else {
          updateArgs({ [key]: value });
        }
      },
    }),
  };
  const Control = Controls[control.type] || NoControl;
  return <Control {...props} {...control} controlType={control.type} />;
};
