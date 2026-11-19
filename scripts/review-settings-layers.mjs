// Run pnpm build first. Uses an isolated browser and a synthetic high-layer Diff scrollbar.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
mkdirSync('.review', { recursive: true });
writeFileSync('.review/settings-layer-harness.tsx', `
import { setLocale } from '../src/shared/i18n';
setLocale('en');
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogHeader } from '../src/shared/ui/Dialog';
import { SettingsMenu } from '../src/app/layouts/SettingsMenu';
import { defaultShortcutPreferences } from '../src/features/settings/model/shortcut-preferences';
createRoot(document.getElementById('root')!).render(<main className="appShell"><header className="titlebar" style={{ justifyContent: 'flex-end' }}><SettingsMenu shortcuts={defaultShortcutPreferences} isMacPlatform={false} onOpenSettings={() => { }}/></header><div className="appPageContent" data-settings-background><div data-diff-scrollbar style={{ position: 'absolute', zIndex: 14, right: 0, top: 130, bottom: 0, width: 18, background: 'red' }}>Diff</div></div><Dialog className="settingsPage" fullPage backgroundSelector="[data-settings-background]" onClose={() => { }}><DialogHeader><h2>Settings</h2></DialogHeader><div className="settingsContent" style={{ height: '100%', padding: 24 }}>General settings</div></Dialog></main>);
`);
await esbuild.build({ entryPoints: ['.review/settings-layer-harness.tsx'], bundle: true, loader: { '.wasm': 'empty' }, format: 'esm', outfile: '.review/settings-layer-bundle.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = readFileSync('out/renderer/assets/' + readdirSync('out/renderer/assets').find(f => /^index-.*\.css$/.test(f)));
const html = '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script>';
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html'); res.end(req.url === '/bundle.js' ? readFileSync('.review/settings-layer-bundle.js') : req.url === '/style.css' ? css : html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => console.log('ERROR', e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('menu').waitFor();
    // Inert excludes background elements from hit testing but does not suppress their paint.
    // Temporarily enable hit testing to detect a visible scrollbar crossing the Settings layer.
    const result = await page.evaluate(() => { const bg = document.querySelector('[data-settings-background]'); const wasInert = bg.inert; bg.inert = false; const menu = document.querySelector('.quickSettingsMenu'); const r = menu.getBoundingClientRect(); const result = { menuClickable: !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.quickSettingsMenu'), diffLeaked: !!document.elementFromPoint(innerWidth - 8, 300)?.closest('[data-diff-scrollbar]') }; bg.inert = wasInert; return result; });
    console.log(result);
    assert.deepEqual(result, { menuClickable: true, diffLeaked: false });
    await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 1);
    // Titlebar stays below modal backdrops even while it sits above the Settings page.
    await page.evaluate(() => { const modal = document.createElement('div'); modal.className = 'paletteBackdrop'; modal.dataset.testModal = ''; document.body.append(modal); });
    assert(await page.evaluate(() => document.elementFromPoint(innerWidth - 24, 20)?.matches('[data-test-modal]')));
    await page.evaluate(() => document.querySelector('[data-test-modal]').remove());
    mkdirSync('.review/settings-layers', { recursive: true });
    await page.screenshot({ path: '.review/settings-layers/fixed.png' });
    console.log('Settings layer checks passed.');
}
finally {
    await browser?.close();
    await new Promise(r => server.close(r));
}
