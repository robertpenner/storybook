import type { ChangeEvent, FC } from 'react';
import React, { useMemo } from 'react';

import { darken, lighten, rgba } from 'polished';
import { styled } from 'storybook/theming';

import { parse } from './Number';
import { getControlId } from './helpers';
import type { ControlProps, NumberValue, RangeConfig } from './types';

type RangeProps = ControlProps<NumberValue | null> & RangeConfig;

const RangeInput = styled.input(({ theme, disabled }) => {
  // Shared track background gradient
  const remainingTrack =
    theme.base === 'light'
      ? darken(0.02, theme.input.background)
      : lighten(0.02, theme.input.background);
  const trackBackground = `linear-gradient(to right, ${theme.color.green} 0%, ${theme.color.green} var(--range-progress), ${remainingTrack} var(--range-progress), ${remainingTrack} 100%)`;

  // Shared track base styles
  const trackBaseStyles = {
    background: trackBackground,
    borderRadius: 6,
    boxShadow: `${theme.base == 'dark' ? 'hsl(0 0 100 / 0.4)' : 'hsl(0 0 0 / 0.44)'} 0 0 0 1px inset`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    height: 6,
    width: '100%',
  };

  const trackFocusStyles = {
    borderColor: rgba(theme.color.secondary, 0.4),
  };

  // Shared thumb base styles
  const thumbBaseStyles = {
    width: 16,
    height: 16,
    borderRadius: 50,
    cursor: disabled ? 'not-allowed' : 'grab',
    background: theme.input.background,
    border: `1px solid ${theme.base == 'dark' ? 'hsl(0 0 100 / 0.4)' : 'hsl(0 0 0 / 0.44)'}`,
    boxShadow:
      theme.base === 'light' ? `0 1px 3px 0px ${rgba(theme.appBorderColor, 0.2)}` : 'unset',
    transition: 'all 150ms ease-out',
  };

  // Shared thumb hover styles
  const thumbHoverStyles = {
    background: `${darken(0.05, theme.input.background)}`,
    transform: 'scale3d(1.1, 1.1, 1.1) translateY(-1px)',
    transition: 'all 50ms ease-out',
  };

  // Shared thumb active styles
  const thumbActiveStyles = {
    background: `${theme.input.background}`,
    transform: 'scale3d(1, 1, 1) translateY(0px)',
  };

  const thumbFocusStyles = {
    borderColor: theme.color.secondary,
    boxShadow: theme.base === 'light' ? `0 0px 5px 0px ${theme.color.secondary}` : 'unset',
  };

  return {
    // Restyled using http://danielstern.ca/range.css/#/
    appearance: 'none',
    backgroundColor: 'transparent',
    width: '100%',

    // Track styles
    '&::-webkit-slider-runnable-track': trackBaseStyles,

    '&::-moz-range-track': trackBaseStyles,

    '&::-ms-track': {
      ...trackBaseStyles,
      color: 'transparent',
    },

    // Thumb styles
    '&::-moz-range-thumb': {
      ...thumbBaseStyles,

      '&:hover': thumbHoverStyles,
      '&:active': thumbActiveStyles,
    },

    '&::-webkit-slider-thumb': {
      ...thumbBaseStyles,
      marginTop: '-6px',
      appearance: 'none',

      '&:hover': thumbHoverStyles,
      '&:active': thumbActiveStyles,
    },

    '&::-ms-thumb': {
      ...thumbBaseStyles,
      marginTop: 0,

      '&:hover': thumbHoverStyles,
      '&:active': thumbActiveStyles,
    },

    '&:focus': {
      outline: 'none',

      '&::-webkit-slider-runnable-track': trackFocusStyles,
      '&::-moz-range-track': trackFocusStyles,
      '&::-ms-track': trackFocusStyles,

      '&::-webkit-slider-thumb': thumbFocusStyles,
      '&::-moz-range-thumb': thumbFocusStyles,
      '&::-ms-thumb': thumbFocusStyles,
    },

    '&::-ms-fill-lower': {
      borderRadius: 6,
    },

    '&::-ms-fill-upper': {
      borderRadius: 6,
    },

    '@supports (-ms-ime-align:auto)': { 'input[type=range]': { margin: '0' } },
  };
});

const RangeLabel = styled.span({
  paddingLeft: 5,
  paddingRight: 5,
  fontSize: 12,
  whiteSpace: 'nowrap',
  fontFeatureSettings: 'tnum',
  fontVariantNumeric: 'tabular-nums',
});

const RangeCurrentAndMaxLabel = styled(RangeLabel)<{
  numberOFDecimalsPlaces: number;
  max: number;
}>(({ numberOFDecimalsPlaces, max }) => ({
  // Fixed width of "current / max" label to avoid slider width changes
  // 3 = size of separator " / "
  width: `${numberOFDecimalsPlaces + max.toString().length * 2 + 3}ch`,
  textAlign: 'right',
  flexShrink: 0,
}));

const RangeWrapper = styled.div<{ readOnly: boolean }>(({ readOnly }) => ({
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  opacity: readOnly ? 0.5 : 1,
}));

function getNumberOfDecimalPlaces(number: number) {
  const match = number.toString().match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  return !match
    ? 0
    : Math.max(
        0,
        // Number of digits right of decimal point.
        (match[1] ? match[1].length : 0) -
          // Adjust for scientific notation.
          (match[2] ? +match[2] : 0)
      );
}

function rangeProgress(value: number, min: number, max: number) {
  const percentage = ((value - min) / (max - min)) * 100;
  return `${Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0}%`;
}

export const RangeControl: FC<RangeProps> = ({
  name,
  storyId,
  controlsId,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  onBlur,
  onFocus,
  argType,
  required,
}) => {
  const numberOFDecimalsPlaces = useMemo(() => getNumberOfDecimalPlaces(step), [step]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(parse(event.currentTarget.value));
  };

  const readonly = !!argType?.table?.readonly;
  const controlId = getControlId(name, storyId, controlsId);
  const rangeStyle: React.CSSProperties & { '--range-progress': string } = {
    '--range-progress': rangeProgress(value ?? min, min, max),
  };

  return (
    <RangeWrapper readOnly={readonly}>
      <label htmlFor={controlId} className="sb-sr-only">
        {name}
      </label>
      <RangeLabel>{min}</RangeLabel>
      <RangeInput
        id={controlId}
        type="range"
        disabled={readonly}
        onChange={handleChange}
        aria-required={required || undefined}
        {...{ name, min, max, step, onFocus, onBlur }}
        style={rangeStyle}
        value={value ?? min}
      />
      <RangeCurrentAndMaxLabel numberOFDecimalsPlaces={numberOFDecimalsPlaces} max={max}>
        {value == null ? '--' : value.toFixed(numberOFDecimalsPlaces)} / {max}
      </RangeCurrentAndMaxLabel>
    </RangeWrapper>
  );
};
