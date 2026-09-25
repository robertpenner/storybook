import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useRef, useState } from 'react';
import { addons, useArgs } from 'storybook/preview-api';

function record(kind: string, detail: Record<string, unknown> = {}) {
  window.dispatchEvent(new CustomEvent('controls-latency', { detail: { kind, ...detail } }));
}

const channel = addons.getChannel();
for (const event of [
  'updateStoryArgs',
  'storyArgsUpdated',
  'storyRenderPhaseChanged',
  'storyRendered',
  'storyFinished',
]) {
  channel.on(event, (detail: unknown) => record(event, { detail }));
}

function Marker({
  value,
  finiteAnimation,
  onChange,
  onReset,
}: {
  value: number;
  finiteAnimation: boolean;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const inputPath = new URLSearchParams(location.search).get('latencyInput') ?? 'manager';
  const [localValue, setLocalValue] = useState(value);
  const displayed = inputPath === 'local' ? localValue : value;
  const flash = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    record('commit', { value: displayed });
    if (finiteAnimation) {
      const animation = flash.current?.animate([{ opacity: 1 }, { opacity: 0.3 }], {
        duration: 120,
      });
      return () => animation?.cancel();
    }
  }, [displayed, finiteAnimation]);

  return (
    <main
      style={{
        minHeight: '100vh',
        padding: 32,
        background: '#10161b',
        color: '#e8edf2',
        fontFamily: 'monospace',
      }}
    >
      <h1 style={{ fontSize: 20 }}>Controls Latency</h1>
      <output
        data-latency-output={displayed}
        style={{
          display: 'block',
          fontSize: 28,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {displayed}
      </output>
      <div
        style={{
          position: 'relative',
          height: 56,
          marginBlock: 24,
          background: '#25292e',
        }}
      >
        <div
          data-latency-marker
          style={{
            position: 'absolute',
            width: 8,
            height: 56,
            background: '#63deba',
            left: `calc(${displayed / 10}% - ${displayed / 125}px)`,
          }}
        />
      </div>
      <div ref={flash} style={{ height: 4, background: '#eebf67', opacity: 0.3 }} />
      {inputPath !== 'manager' && (
        <div style={{ marginTop: 24 }}>
          <label htmlFor="latency-value">Value</label>
          <input
            id="latency-value"
            aria-label="Value"
            type="range"
            min={0}
            max={1000}
            step={1}
            value={displayed}
            style={{ display: 'block', width: '100%' }}
            onChange={(event) => {
              const nextValue = Number(event.currentTarget.value);
              if (inputPath === 'local') setLocalValue(nextValue);
              else onChange(nextValue);
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (inputPath === 'local') setLocalValue(0);
              else onReset();
            }}
          >
            Reset
          </button>
        </div>
      )}
    </main>
  );
}

const delay = async (phase: string) => {
  record(`${phase}:start`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  record(`${phase}:end`);
};

const meta = {
  title: 'Diagnostics/Controls Latency',
  args: { value: 0, finiteAnimation: false },
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 1000, step: 1 } },
    finiteAnimation: { control: false, table: { disable: true } },
  },
  parameters: { layout: 'fullscreen' },
  render: function ControlsLatency() {
    const [args, updateArgs, resetArgs] = useArgs<{
      value: number;
      finiteAnimation: boolean;
    }>();
    return (
      <Marker
        {...args}
        onChange={(value) => updateArgs({ value })}
        onReset={() => resetArgs(['value'])}
      />
    );
  },
} satisfies Meta<{ value: number; finiteAnimation: boolean }>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Baseline: Story = {};
export const FiniteAnimation: Story = { args: { finiteAnimation: true } };
export const LoaderDelay: Story = {
  loaders: [
    async () => {
      await delay('loader');
      return {};
    },
  ],
};
export const BeforeEachDelay: Story = {
  beforeEach: async () => delay('beforeEach'),
};
export const AfterEachDelay: Story = {
  afterEach: async () => delay('afterEach'),
};
export const Play: Story = {
  play: async () => {
    record('play');
  },
};
export const Mount: Story = {
  play: async ({ mount }) => {
    record('mount');
    await mount();
  },
};
