import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { useRef, useState } from 'react';

import { expect, fireEvent, fn, userEvent } from 'storybook/test';

import { RangeControl } from '../../addons/docs/src/blocks/controls/Range.tsx';
import { ArgsTable } from '../../addons/docs/src/blocks/components/ArgsTable/ArgsTable.tsx';
import type { ArgsInteraction } from 'storybook/preview-api';

function RangeTable({
  supported = true,
  controlType = 'range',
  ...props
}: ComponentProps<typeof RangeControl> & {
  supported?: boolean;
  controlType?: 'range' | 'number';
}) {
  const [args, setArgs] = useState({ range: props.value });
  const start = useRef(args);
  const interaction: ArgsInteraction = {
    begin: () => {
      start.current = args;
      props.onGestureStart?.();
      return supported;
    },
    update: (updated) => {
      props.onChange(updated.range);
      // An older preview acknowledgement must not replace the focused local value.
      setArgs({ range: 7 });
    },
    finish: async (updated) => {
      props.onGestureFinish?.(updated?.range);
      const finalArgs = { range: updated?.range };
      setArgs(finalArgs);
      return { status: 'completed', args: finalArgs };
    },
    cancel: async () => {
      props.onGestureCancel?.(start.current.range);
      setArgs(start.current);
      return { status: 'cancelled' };
    },
  };
  return (
    <div style={{ minHeight: '100vh', padding: 32, background: '#10161b', color: '#e8edf2' }}>
      <ArgsTable
        rows={{
          range: {
            name: 'range',
            control: { type: controlType, min: 0, max: 100 },
          },
        }}
        args={args}
        updateArgs={(updated) => {
          props.onChange(updated.range);
          setArgs({ range: updated.range });
        }}
        argsInteraction={interaction}
        resetArgs={() => setArgs({ range: 0 })}
      />
    </div>
  );
}

function DelayedRange({
  value: initialValue,
  onChange,
  ...props
}: ComponentProps<typeof RangeControl>) {
  const [value, setValue] = useState(initialValue);
  const pending = useRef<typeof value>(undefined);

  return (
    <div style={{ minHeight: '100vh', padding: 32, background: '#10161b', color: '#e8edf2' }}>
      <RangeControl
        {...props}
        value={value}
        onChange={(next) => {
          pending.current = next;
          setValue(next);
          onChange(next);
        }}
      />
      <button type="button" onClick={() => setValue(pending.current)}>
        Acknowledge
      </button>
      <button type="button" onClick={() => setValue(0)}>
        Reset
      </button>
    </div>
  );
}

const meta = {
  title: 'Diagnostics/Range Control',
  component: RangeControl,
  tags: ['vitest'],
  args: {
    name: 'range',
    min: 0,
    max: 100,
    value: 20,
    onChange: fn(),
    onFocus: fn(),
    onBlur: fn(),
  },
  render: (args) => <DelayedRange {...args} />,
} satisfies Meta<typeof RangeControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DelayedAcknowledgement: Story = {
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await expect(slider).toHaveValue('20');
    await expect(slider).toHaveStyle({ '--range-progress': '20%' });

    await userEvent.click(slider);
    await expect(args.onFocus).toHaveBeenCalled();
    await fireEvent.input(slider, { target: { value: '100' } });
    await expect(slider).toHaveValue('100');
    await expect(slider).toHaveStyle({ '--range-progress': '100%' });
    await expect(slider.nextElementSibling).toHaveTextContent(/100\s*\/\s*100/);
    await expect(args.onChange).toHaveBeenCalledWith(100);

    await userEvent.click(canvas.getByRole('button', { name: 'Acknowledge' }));
    await expect(args.onBlur).toHaveBeenCalled();
    await expect(slider).toHaveValue('100');
    await expect(slider).toHaveStyle({ '--range-progress': '100%' });

    await userEvent.click(canvas.getByRole('button', { name: 'Reset' }));
    await expect(slider).toHaveValue('0');
    await expect(slider).toHaveStyle({ '--range-progress': '0%' });
    await expect(slider.nextElementSibling).toHaveTextContent(/0\s*\/\s*100/);
  },
};

export const PointerCompletion: Story = {
  args: {
    onGestureStart: fn(),
    onGestureFinish: fn(),
    onGestureCancel: fn(),
  },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.pointerDown(slider, { pointerId: 1, button: 0 });
    await fireEvent.input(slider, { target: { value: '73' } });
    await fireEvent.pointerUp(slider, { pointerId: 1 });
    await fireEvent.blur(slider);
    await expect(args.onGestureStart).toHaveBeenCalledTimes(1);
    await expect(args.onGestureFinish).toHaveBeenCalledExactlyOnceWith(73);
    await expect(args.onGestureCancel).not.toHaveBeenCalled();
  },
};

export const KeyboardRetainsDeliveredInput: Story = {
  render: (args) => <RangeControl {...args} />,
  args: { onGestureStart: fn(), onGestureFinish: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.focus(slider);
    await fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await fireEvent.input(slider, { target: { value: '91' } });
    await expect(slider).toHaveValue('20');
    await fireEvent.keyUp(slider, { key: 'ArrowRight' });
    await fireEvent.blur(slider);
    await expect(args.onGestureStart).toHaveBeenCalledTimes(1);
    await expect(args.onGestureFinish).toHaveBeenCalledExactlyOnceWith(91);
  },
};

export const BlurCompletion: Story = {
  args: { onGestureStart: fn(), onGestureFinish: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.focus(slider);
    await fireEvent.keyDown(slider, { key: 'PageUp' });
    await fireEvent.input(slider, { target: { value: '41' } });
    await fireEvent.blur(slider);
    await fireEvent.keyUp(slider, { key: 'PageUp' });
    await expect(args.onGestureFinish).toHaveBeenCalledExactlyOnceWith(41);
  },
};

export const FocusedLocalFeedback: Story = {
  render: (args) => <RangeTable {...args} />,
  args: { onGestureStart: fn(), onGestureFinish: fn(), onGestureCancel: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.pointerDown(slider, { pointerId: 1, button: 0 });
    await fireEvent.input(slider, { target: { value: '79' } });
    await expect(slider).toHaveValue('79');
    await expect(slider).toHaveStyle({ '--range-progress': '79%' });
    await expect(slider.nextElementSibling).toHaveTextContent(/79\s*\/\s*100/);
    await fireEvent.pointerUp(slider, { pointerId: 1 });
    await fireEvent.blur(slider);
    await expect(args.onGestureFinish).toHaveBeenCalledExactlyOnceWith(79);
    await expect(slider).toHaveValue('79');
  },
};

export const PointerCancellation: Story = {
  render: (args) => <RangeTable {...args} />,
  args: { onGestureStart: fn(), onGestureFinish: fn(), onGestureCancel: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.pointerDown(slider, { pointerId: 1, button: 0 });
    await fireEvent.input(slider, { target: { value: '79' } });
    await expect(slider).toHaveValue('79');
    await fireEvent.pointerCancel(slider, { pointerId: 1 });
    await fireEvent.blur(slider);
    await expect(slider).toHaveValue('20');
    await expect(slider).toHaveStyle({ '--range-progress': '20%' });
    await expect(args.onGestureCancel).toHaveBeenCalledExactlyOnceWith(20);
    await expect(args.onGestureFinish).not.toHaveBeenCalled();
  },
};

export const ResetClearsGesture: Story = {
  render: (args) => <RangeTable {...args} />,
  args: { onGestureStart: fn(), onGestureFinish: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.focus(slider);
    await fireEvent.keyDown(slider, { key: 'Home' });
    await fireEvent.input(slider, { target: { value: '73' } });
    await expect(slider).toHaveValue('73');
    await fireEvent.click(canvas.getByRole('button', { name: 'Reset controls' }));
    await expect(slider).toHaveValue('0');
    await fireEvent.blur(slider);
    await fireEvent.keyUp(slider, { key: 'Home' });
    await expect(args.onGestureFinish).not.toHaveBeenCalled();
    await expect(slider).toHaveValue('0');
  },
};

export const OrdinaryFallbackCancellation: Story = {
  render: (args) => <RangeTable {...args} supported={false} />,
  args: { onGestureStart: fn(), onGestureFinish: fn(), onGestureCancel: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.pointerDown(slider, { pointerId: 1, button: 0 });
    await fireEvent.input(slider, { target: { value: '79' } });
    await expect(args.onChange).toHaveBeenCalledWith(79);
    await fireEvent.pointerCancel(slider, { pointerId: 1 });
    await expect(args.onChange).toHaveBeenLastCalledWith(20);
    await expect(slider).toHaveValue('20');
    await expect(args.onGestureCancel).not.toHaveBeenCalled();
    await expect(args.onGestureFinish).not.toHaveBeenCalled();
  },
};

export const KeyboardRangeKeys: Story = {
  render: (args) => <RangeControl {...args} />,
  args: { onGestureStart: fn(), onGestureFinish: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.keyDown(slider, { key: 'Enter' });
    await fireEvent.keyUp(slider, { key: 'Enter' });
    await expect(args.onGestureStart).not.toHaveBeenCalled();
    const keys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown',
      'Home',
      'End',
    ];
    for (const [index, key] of keys.entries()) {
      await fireEvent.keyDown(slider, { key });
      await fireEvent.keyDown(slider, { key, repeat: true });
      await fireEvent.input(slider, { target: { value: '42' } });
      await fireEvent.keyUp(slider, { key });
      await expect(args.onGestureStart).toHaveBeenCalledTimes(index + 1);
      await expect(args.onGestureFinish).toHaveBeenCalledTimes(index + 1);
      await expect(args.onGestureFinish).toHaveBeenLastCalledWith(42);
    }
  },
};

export const CancellationRestoresUnsetValue: Story = {
  render: (args) => <RangeTable {...args} supported={false} />,
  args: { value: null, onGestureStart: fn(), onGestureFinish: fn() },
  play: async ({ canvas, args }) => {
    const slider = canvas.getByRole('slider', { name: 'range' });
    await fireEvent.pointerDown(slider, { pointerId: 1, button: 0 });
    await fireEvent.input(slider, { target: { value: '79' } });
    await fireEvent.pointerCancel(slider, { pointerId: 1 });
    await expect(args.onChange).toHaveBeenLastCalledWith(null);
    await expect(slider.nextElementSibling).toHaveTextContent(/--\s*\/\s*100/);
    await expect(args.onGestureFinish).not.toHaveBeenCalled();
  },
};

export const NonRangeUsesOrdinaryUpdates: Story = {
  render: (args) => <RangeTable {...args} controlType="number" />,
  args: { onGestureStart: fn(), onGestureFinish: fn(), onGestureCancel: fn() },
  play: async ({ canvas, args }) => {
    const number = canvas.getByRole('spinbutton');
    await fireEvent.focus(number);
    await fireEvent.input(number, { target: { value: '64' } });
    await fireEvent.blur(number);
    await expect(args.onChange).toHaveBeenCalledExactlyOnceWith(64);
    await expect(args.onGestureStart).not.toHaveBeenCalled();
    await expect(args.onGestureFinish).not.toHaveBeenCalled();
    await expect(number).toHaveValue(64);
  },
};
