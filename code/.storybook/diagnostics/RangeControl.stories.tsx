import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { useRef, useState } from 'react';

import { expect, fireEvent, fn, userEvent } from 'storybook/test';

import { RangeControl } from '../../addons/docs/src/blocks/controls/Range.tsx';

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
