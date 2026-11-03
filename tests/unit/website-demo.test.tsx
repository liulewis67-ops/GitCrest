// @vitest-environment jsdom
import { createElement, forwardRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitCrestApiClient } from '../../src/api/client';
import { installDemoEnvironment, DEMO_REPO_ID } from '../../website/demo-environment';

// Monaco's browser worker is exercised by the production build, not jsdom.
vi.mock('../../src/features/diff/ui/MonacoFileDiff', () => ({
  MonacoFileDiff: forwardRef((_props: { original: string; modified: string; label: string }, _ref) => createElement('pre', { 'aria-label': _props.label }, `${_props.original}\n${_props.modified}`)),
}));
vi.mock('../../src/features/diff/model/use-code-review-analysis', () => ({
  useCodeReviewAnalysis: () => ({ status: 'off' }),
}));

const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
const originalBridge = Object.getOwnPropertyDescriptor(window, 'gitcrest');
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
  if (originalBridge) Object.defineProperty(window, 'gitcrest', originalBridge);
  else delete window.gitcrest;
  vi.unstubAllGlobals();
});

it('renders the actual client workspace, switches to the real history view, and changes only in-memory data', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const demo = installDemoEnvironment(window);
  const { setLocale } = await import('../../src/shared/i18n');
  setLocale('en');
  const { default: App } = await import('../../src/app/App');
  const view = render(createElement(App));
  await waitFor(() => expect(view.container.querySelector('.workspacePage')).not.toBeNull());
  expect(view.container.querySelector('.titlebar')).not.toBeNull();
  expect(view.container.querySelector('.workspaceToolbar')).not.toBeNull();
  expect((await screen.findByRole('tab', { name: /Workspace/ })).getAttribute('aria-selected')).toBe('true');
  expect((await screen.findAllByText('navigation.ts')).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  await waitFor(() => expect(view.container.querySelector('.historyLayout')).not.toBeNull());
  expect((await screen.findAllByText('Keep repository context when switching views')).length).toBeGreaterThan(0);
  expect(view.container.querySelector('.historyChangesPane')).not.toBeNull();

  const connection = await demo.bridge.getSidecarConnection();
  const client = new GitCrestApiClient(connection.baseUrl, connection.token);
  const initial = await client.getRepositoryStatus(DEMO_REPO_ID);
  expect(initial.files.find(file => file.path === 'src/navigation.ts')?.categories).toEqual(['unstaged']);
  await client.stageRepositoryChanges(DEMO_REPO_ID, { action: 'stageFile', path: 'src/navigation.ts' });
  const staged = await client.getRepositoryStatus(DEMO_REPO_ID);
  expect(staged.files.find(file => file.path === 'src/navigation.ts')?.categories).toEqual(['staged']);
  await client.commitRepository(DEMO_REPO_ID, 'Website demo commit');
  expect((await client.getRepositoryCommits(DEMO_REPO_ID)).commits[0].subject).toBe('Website demo commit');
  expect((await client.getRepositoryStatus(DEMO_REPO_ID)).files.every(file => !file.categories.includes('staged'))).toBe(true);
  expect(demo.storage).not.toBe(originalStorage?.get?.call(window));
  expect((await demo.fetch('http://127.0.0.1:47800/api/version')).status).toBe(409);
  expect((await demo.fetch('https://example.com/api')).status).toBe(409);
}, 30_000);
