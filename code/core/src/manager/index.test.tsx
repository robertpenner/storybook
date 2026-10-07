import type { ReactNode } from 'react';
import React from 'react';

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type ThemeVars, themes, useTheme } from 'storybook/theming';

import { Main } from './index.tsx';
import Provider from './provider.ts';

const { readTheme, fixture } = vi.hoisted(() => {
  const state: { theme?: ThemeVars; layout: object; viewMode: string } = {
    layout: {},
    viewMode: 'story',
  };
  return {
    readTheme: vi.fn(),
    fixture: {
      state,
      api: { getElements: () => ({}), getQueryParam: () => undefined, setSizes: vi.fn() },
    },
  };
});

vi.mock('storybook/manager-api', () => ({
  Provider: ({ children }: { children: (combo: typeof fixture) => ReactNode }) => children(fixture),
  types: { experimental_PAGE: 'experimental_PAGE' },
}));

vi.mock('storybook/internal/router', () => ({
  Location: ({ children }: { children: (location: object) => ReactNode }) => children({}),
  useNavigate: () => vi.fn(),
}));

vi.mock('./settings/index.tsx', () => ({ settingsPageAddon: {} }));
vi.mock('./components/layout/LayoutProvider.tsx', () => ({
  LayoutProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./App.tsx', () => ({
  App: () => {
    readTheme(useTheme());
    return null;
  },
}));

describe('manager theme', () => {
  it('preserves the theme across unrelated manager updates and applies theme changes', () => {
    fixture.state.theme = themes.light;
    const provider = new Provider();
    const view = render(<Main provider={provider} />);
    const initialTheme = readTheme.mock.lastCall?.[0];
    expect(initialTheme).toBeDefined();

    fixture.state = { ...fixture.state };
    view.rerender(<Main provider={provider} />);
    expect(readTheme.mock.lastCall?.[0]).toBe(initialTheme);

    fixture.state = { ...fixture.state, theme: themes.dark };
    view.rerender(<Main provider={provider} />);
    expect(readTheme.mock.lastCall?.[0]).not.toBe(initialTheme);
    expect(readTheme.mock.lastCall?.[0]).toMatchObject({ base: 'dark' });
  });
});
// @vitest-environment happy-dom
