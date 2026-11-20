// Build first. Reviews the user flow in an isolated Electron profile and disposable repository.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withReviewApp } from './review-window.mjs';
import { createReviewFixture } from './review-fixture.mjs';
const output = process.argv[2] || '.review/flow-after';
await mkdir(output, { recursive: true });
const fixture = await createReviewFixture();
await withReviewApp(async (app, page) => {
    const native = await app.browserWindow(page);
    await native.evaluate(win => win.setContentSize(1280, 850));
    await native.dispose();
    await page.evaluate(() => { localStorage.setItem('gitcrest-locale', 'en'); localStorage.setItem('gitcrest-appearance-v1', JSON.stringify({ mode: 'light' })); });
    await page.reload();
    await page.getByRole('button', { name: 'Open local repository', exact: true }).waitFor();
    await page.screenshot({ scale: "css", path: join(output, 'welcome.png') });
    const repo = await page.evaluate(async (path) => { const c = await window.gitcrest.getSidecarConnection(); const r = await fetch(c.baseUrl + '/api/v1/repositories', { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'X-GitCrest-API-Version': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }); if (!r.ok)
        throw Error(await r.text()); return r.json(); }, fixture.path);
    await page.evaluate(repo => localStorage.setItem('gitcrest-workspace-session-v1', JSON.stringify({ openRepoIds: [repo.repoId], activeRepoId: repo.repoId, tabs: { [repo.repoId]: { mode: 'changes', graphScrollTop: 0 } } })), repo);
    await page.reload();
    await page.getByRole('textbox', { name: 'Commit message', exact: true }).waitFor();
    await page.locator('.monaco-diff-editor').first().waitFor();
    await page.screenshot({ scale: "css", path: join(output, 'workspace.png') });
    await page.getByRole('button', { name: 'Write a commit summary', exact: true }).click();
    if (!await page.getByRole('textbox', { name: 'Commit message', exact: true }).evaluate(node => node === document.activeElement))
        throw Error('Summary focus lost');
    await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Improve the review flow');
    if (!await page.getByRole('button', { name: 'Commit', exact: true }).isEnabled())
        throw Error('Commit did not become available');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('menuitem', { name: /All settings/ }).click();
    await page.locator('.settingsPage').waitFor();
    await page.screenshot({ scale: "css", path: join(output, 'general.png') });
    await page.locator('.settingsNav button').filter({ hasText: /^Automations$/ }).click();
    await page.getByRole('button', { name: 'Add Hook', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
    if (output.includes('after'))
        await page.waitForFunction(() => { const b = document.querySelector('.hookEditorActions')?.getBoundingClientRect(); return b && b.bottom <= innerHeight && b.top > 120 && document.activeElement?.getAttribute('type') === 'text'; });
    await page.screenshot({ scale: "css", path: join(output, 'hook.png') });
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Review Hook');
    const target = page.getByRole('combobox', { name: 'Choose a remote branch', exact: true });
    await target.click();
    const search = page.getByRole('combobox', { name: 'Search options…', exact: true });
    await search.fill('main');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Add target', exact: true }).click();
    await page.getByRole('button', { name: 'Save Hook', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-hook-edit'));
    await page.getByRole('button', { name: 'Add Hook', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
    await page.locator('.pipelineRuleEditor').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Add Hook');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '中文', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '添加 Hook', exact: true }).click();
    const small = await app.browserWindow(page);
    await small.evaluate(win => win.setContentSize(800, 650));
    await small.dispose();
    await page.getByRole('textbox', { name: '名称', exact: true }).waitFor();
    await page.waitForFunction(() => { const b = document.querySelector('.hookEditorActions')?.getBoundingClientRect(); return b && b.bottom <= innerHeight + 1 && b.top > 80; });
    const duration = await page.locator('.hookEditorActions').evaluate(node => getComputedStyle(node.closest('.sharedDialog')).animationDuration);
    await page.screenshot({ scale: 'css', path: join(output, 'hook-zh-dark-small.png') });
    console.log('Verified summary focus, Commit readiness, Hook save/cancel focus return, small dark Chinese layout, reduced motion:', duration);
    console.log('Captured', output);
});
