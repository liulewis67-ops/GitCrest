// Build first. Optional arguments: output folder, path to the desktop-agent-ui clip-audit.js.
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
// Build first. Reviews the user flow in an isolated Electron profile and disposable repository.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withReviewApp } from './review-window.mjs';
import { createReviewFixture } from './review-fixture.mjs';
const output = process.argv[2] || '.review/desktop-skill-fixed';
await mkdir(output, { recursive: true });
const fixture = await createReviewFixture();
const auditSource = await readFile(process.argv[3] || join(homedir(), '.codex/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
const results = { clips: {}, checks: {} };
let inspect;
await withReviewApp(async (app, page) => {
    inspect = async (name) => { results.clips[name] = await page.evaluate('(' + auditSource + ')({viewport:true,max:80})'); await page.screenshot({ scale: 'css', path: join(output, name + '.png') }); console.log(name, results.clips[name].cut); };
    const native = await app.browserWindow(page);
    await native.evaluate(win => win.setContentSize(1280, 850));
    await native.dispose();
    await page.evaluate(() => { localStorage.setItem('gitcrest-locale', 'en'); localStorage.setItem('gitcrest-appearance-v1', JSON.stringify({ mode: 'light' })); });
    await page.reload();
    await page.getByRole('button', { name: 'Open local repository', exact: true }).waitFor();
    await inspect('welcome-default');
    const repo = await page.evaluate(async (path) => {
        const c = await window.gitcrest.getSidecarConnection();
        const r = await fetch(c.baseUrl + '/api/v1/repositories', { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'X-GitCrest-API-Version': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
        if (!r.ok)
            throw Error(await r.text());
        return r.json();
    }, fixture.path);
    await page.evaluate(repo => localStorage.setItem('gitcrest-workspace-session-v1', JSON.stringify({ openRepoIds: [repo.repoId], activeRepoId: repo.repoId, tabs: { [repo.repoId]: { mode: 'changes', graphScrollTop: 0 } } })), repo);
    await page.reload();
    await page.getByRole('textbox', { name: 'Commit message', exact: true }).waitFor();
    await page.locator('.monaco-diff-editor').first().waitFor();
    await inspect('workspace-default');
    await page.getByRole('button', { name: 'Diff options', exact: true }).click();
    await inspect('diff-options-open');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    if (await page.locator('.fileDiffOptionsBody').count() !== 0)
        throw Error('Popover Tab did not close');
    if (!await page.evaluate(() => document.activeElement?.closest('.fileDiffToolbar')))
        throw Error('Popover focus left toolbar');
    results.checks.popoverTab = true;
    results.checks.window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    results.checks.fonts = await page.evaluate(() => { const all = [...document.querySelectorAll('*')].filter(el => el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); return { sizes: [...new Set(all.map(el => getComputedStyle(el).fontSize))], under12: all.filter(el => parseFloat(getComputedStyle(el).fontSize) < 12).map(el => ({ tag: el.tagName, text: el.textContent.slice(0, 40), size: getComputedStyle(el).fontSize })) }; });
    const splitter = page.getByRole('separator').first();
    const bounds = await splitter.boundingBox();
    if (bounds) {
        const start = await splitter.getAttribute('aria-valuenow');
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width / 2 + 70, bounds.y + bounds.height / 2);
        const moved = await splitter.getAttribute('aria-valuenow');
        await page.keyboard.press('Escape');
        const escaped = await splitter.getAttribute('aria-valuenow');
        results.checks.splitterEscape = { start, moved, escaped, reverted: start === escaped, draggingAfterEscape: await splitter.getAttribute('class') };
        await page.mouse.up();
    }
    await page.getByRole('button', { name: 'Write a commit summary', exact: true }).click();
    if (!await page.getByRole('textbox', { name: 'Commit message', exact: true }).evaluate(node => node === document.activeElement))
        throw Error('Summary focus lost');
    await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Improve the review flow');
    if (!await page.getByRole('button', { name: 'Commit', exact: true }).isEnabled())
        throw Error('Commit did not become available');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await inspect('gear-menu-open');
    await page.getByRole('menuitem', { name: /All settings/ }).click();
    await page.locator('.settingsPage').waitFor();
    await inspect('settings-default');
    await page.locator('.settingsNav button').filter({ hasText: /^Automations$/ }).click();
    await page.getByRole('button', { name: 'Add Hook', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
    if (output.includes('after'))
        await page.waitForFunction(() => { const b = document.querySelector('.hookEditorActions')?.getBoundingClientRect(); return b && b.bottom <= innerHeight && b.top > 120 && document.activeElement?.getAttribute('type') === 'text'; });
    await inspect('hook-default');
    await page.getByText('Merge and conflict options', { exact: true }).click();
    await inspect('hook-expanded');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Review Hook');
    const target = page.getByRole('combobox', { name: 'Choose a remote branch', exact: true });
    await target.click();
    await inspect('select-open');
    await page.locator('.searchableSelectOption').first().hover();
    await inspect('select-hover');
    const search = page.getByRole('combobox', { name: 'Search options…', exact: true });
    await search.fill('main');
    await search.dispatchEvent('compositionstart');
    await search.dispatchEvent('compositionend', { data: 'main' });
    await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: false, bubbles: true });
    results.checks.companionEnter = { accepted: (await target.inputValue()) === 'origin/main', popupClosed: await page.getByRole('listbox').count() === 0 };
    if (await page.getByRole('listbox').count() === 0)
        await target.click();
    await page.getByRole('combobox', { name: 'Search options…', exact: true }).fill('main');
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
    await inspect('hook-zh-dark-small');
    const nameField = page.getByRole('textbox', { name: '名称', exact: true });
    await nameField.fill('未保存的配置');
    await nameField.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, bubbles: true });
    results.checks.composingEscape = { settingsClosed: await page.locator('.settingsPage').count() === 0 };
    if (results.checks.composingEscape.settingsClosed)
        throw Error('IME Escape closed Settings');
    await nameField.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: false, bubbles: true });
    if (await page.locator('.settingsPage').count() !== 0)
        throw Error('Normal Escape no longer closes Settings');
    if (!results.checks.splitterEscape.reverted || results.checks.splitterEscape.draggingAfterEscape.includes('dragging'))
        throw Error('Drag cancellation failed');
    if (results.checks.companionEnter.accepted || results.checks.companionEnter.popupClosed)
        throw Error('Companion Enter selected a branch');
    console.log('Verified summary focus, Commit readiness, Hook save/cancel focus return, small dark Chinese layout, reduced motion:', duration);
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
    if (Object.values(results.clips).some(c => c.cut !== 0))
        throw Error('Shadow clipping remains');
    console.log('Audit results', JSON.stringify(results.checks));
});
