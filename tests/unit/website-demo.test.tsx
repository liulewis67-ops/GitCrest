// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { GitCrestApiClient } from '../../src/api/client';
import { installDemoEnvironment, DEMO_REPO_ID } from '../../website/demo-environment';

const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
const originalBridge = Object.getOwnPropertyDescriptor(window, 'gitcrest');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
  if (originalBridge) Object.defineProperty(window, 'gitcrest', originalBridge);
  else delete window.gitcrest;
});

it('uses in-memory repository data for demo staging and committing', async () => {
  const demo = installDemoEnvironment(window);

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
});

it('rejects requests to both a real core and external origins in demo mode', async () => {
  const demo = installDemoEnvironment(window);
  expect((await demo.fetch('http://127.0.0.1:47800/api/version')).status).toBe(409);
  expect((await demo.fetch('https://example.com/api')).status).toBe(409);
});
