import type { AxeResults } from 'axe-core';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addons } from 'storybook/preview-api';

import { EVENTS } from './constants.ts';

const { axeMock, documentMock } = vi.hoisted(() => {
  const documentMock = {
    body: {},
    getElementById: vi.fn(),
    location: { pathname: '/iframe.html' },
  };

  return {
    documentMock,
    axeMock: {
      reset: vi.fn(),
      configure: vi.fn(),
      run: vi.fn(),
    },
  };
});

vi.mock('@storybook/global', () => ({
  global: {
    document: documentMock,
  },
}));

vi.mock('axe-core', () => ({
  default: axeMock,
}));

vi.mock('storybook/preview-api');
const mockedAddons = vi.mocked(addons);

const axeResults = {
  violations: [],
  passes: [],
  incomplete: [],
  inapplicable: [],
} as Partial<AxeResults> as AxeResults;

describe('a11yRunner', () => {
  let mockChannel: { on: Mock; emit?: Mock };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    documentMock.getElementById.mockReturnValue(null);
    axeMock.run.mockResolvedValue(axeResults);

    mockChannel = { on: vi.fn(), emit: vi.fn() };
    mockedAddons.getChannel.mockReturnValue(
      mockChannel as unknown as ReturnType<typeof addons.getChannel>
    );
  });

  it('should listen to events', async () => {
    await import('./a11yRunner.ts');

    expect(mockedAddons.getChannel).toHaveBeenCalled();
    expect(mockChannel.on).toHaveBeenCalledWith(EVENTS.MANUAL, expect.any(Function));
  });

  it('keeps the next audit configuration unchanged until the running audit finishes', async () => {
    let finish!: (result: AxeResults) => void;
    axeMock.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { run } = await import('./a11yRunner.ts');
    const first = run({ config: { branding: { application: 'first' } } }, 'first');
    await vi.waitFor(() => expect(axeMock.run).toHaveBeenCalledOnce());
    const second = run({ config: { branding: { application: 'second' } } }, 'second');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(axeMock.configure).toHaveBeenCalledOnce();
    finish(axeResults);
    await Promise.all([first, second]);
    expect(axeMock.run).toHaveBeenCalledTimes(2);
    expect(axeMock.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ branding: { application: 'second' } })
    );
  });

  it('releases obsolete automatic waits and skips cancelled pending audits without overlapping axe', async () => {
    let finish!: (result: AxeResults) => void;
    axeMock.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { run } = await import('./a11yRunner.ts');
    const runningController = new AbortController();
    const running = run({}, 'story', runningController.signal);
    await vi.waitFor(() => expect(axeMock.run).toHaveBeenCalledOnce());
    const pendingController = new AbortController();
    const pending = run({}, 'story', pendingController.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = run({}, 'story', new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runningController.abort();
    pendingController.abort();

    await expect(running).resolves.toBeUndefined();
    await expect(pending).resolves.toBeUndefined();
    expect(axeMock.run).toHaveBeenCalledOnce();
    finish(axeResults);
    await expect(current).resolves.toEqual(axeResults);
    expect(axeMock.run).toHaveBeenCalledTimes(2);
  });

  it('does not start an already cancelled audit', async () => {
    const { run } = await import('./a11yRunner.ts');
    const controller = new AbortController();
    controller.abort();
    await expect(run({}, 'story', controller.signal)).resolves.toBeUndefined();
    expect(axeMock.run).not.toHaveBeenCalled();
  });

  it('runs an explicit audit after an automatic audit fails', async () => {
    const { run } = await import('./a11yRunner.ts');
    axeMock.run.mockRejectedValueOnce(new Error('audit failed'));
    await expect(run({}, 'story', new AbortController().signal)).rejects.toThrow('audit failed');
    await expect(run({}, 'story')).resolves.toEqual(axeResults);
    expect(axeMock.run).toHaveBeenCalledTimes(2);
  });

  it('passes disabled configured rules to axe.run when runOnly is present', async () => {
    const { run } = await import('./a11yRunner.ts');
    const input = {
      config: {
        rules: [
          { id: 'target-size', enabled: false },
          { id: 'color-contrast', enabled: true },
        ],
      },
      options: {
        runOnly: ['wcag2a'],
        rules: {
          'button-name': { enabled: false },
        },
      },
    };

    await run(input, 'example-story');

    expect(axeMock.configure).toHaveBeenCalledWith({
      rules: [
        { id: 'region', enabled: false },
        { id: 'target-size', enabled: false },
        { id: 'color-contrast', enabled: true },
      ],
    });
    expect(axeMock.run).toHaveBeenCalledWith(expect.any(Object), {
      runOnly: ['wcag2a'],
      rules: {
        region: { enabled: false },
        'target-size': { enabled: false },
        'button-name': { enabled: false },
      },
    });
    expect(axeMock.run.mock.calls[0][1]).not.toBe(input.options);
    expect(input.options).toEqual({
      runOnly: ['wcag2a'],
      rules: {
        'button-name': { enabled: false },
      },
    });
  });

  it('respects configured rule overrides when collecting disabled rules', async () => {
    const { run } = await import('./a11yRunner.ts');

    await run(
      {
        config: {
          rules: [{ id: 'region', enabled: true }],
        },
        options: {
          runOnly: ['wcag2a'],
        },
      },
      'example-story'
    );

    expect(axeMock.run).toHaveBeenCalledWith(expect.any(Object), {
      runOnly: ['wcag2a'],
    });
  });
});
