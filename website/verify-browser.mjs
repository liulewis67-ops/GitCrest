import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';

const website = await preview({
  configFile: fileURLToPath(new URL('./vite.config.mjs', import.meta.url)),
  preview: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  const address = website.httpServer.address();
  assert.ok(address && typeof address === 'object');
  browser = await chromium.launch({ channel: process.env.GITCREST_WEBSITE_BROWSER_CHANNEL });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/?lang=en`);

  const demo = page.frameLocator('.live-workbench-frame');
  await demo.locator('.workspacePage .workspaceToolbar').waitFor();
  await demo.locator('.titlebar').waitFor();
  assert.equal(await demo.getByRole('tab', { name: /Workspace/ }).getAttribute('aria-selected'), 'true');
  await demo.getByText('navigation.ts', { exact: true }).first().waitFor();

  await demo.getByRole('tab', { name: 'History', exact: true }).click();
  await demo.getByText('Keep repository context when switching views', { exact: true }).first().waitFor();
  await demo.locator('.historyLayout .historyChangesPane').waitFor();
  assert.deepEqual(errors, []);
  console.log('Built website demo opens the workspace and loads the real commit history.');
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise((resolve, reject) => website.httpServer.close((error) => error ? reject(error) : resolve()));
  }
}
