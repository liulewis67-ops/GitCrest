import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// DOM interaction checks, not a substitute for real-browser layout or motion QA.
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const script = (await readFile(new URL('./main.js', import.meta.url), 'utf8')).replace(/^import Lenis from .*;\r?\n/, '');
const dom = new JSDOM(html, { url: 'http://localhost/?lang=zh', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
let scrollOptions;
let stopped = false;
window.Lenis = class {
  constructor(options) { scrollOptions = options; }
  resize() {}
  scrollTo(_target, options) { options?.onComplete?.(); }
  start() { stopped = false; }
  stop() { stopped = true; }
  destroy() {}
};
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.matchMedia = () => Object.assign(new window.EventTarget(), { matches: false });
window.scrollTo = () => {};
window.fetch = async () => ({ ok: true, json: async () => ({ windows: 'https://example.com/gitcrest.exe', macos: null, linux: 'javascript:alert(1)' }) });
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
window.eval(script);
await new Promise(resolve => setTimeout(resolve, 0));
const $ = selector => { const node = document.querySelector(selector); assert.ok(node, `Missing ${selector}`); return node; };
const click = selector => $(selector).click();

assert.equal(document.documentElement.lang, 'zh-CN');
assert.match($('h1').textContent, /看清每一次变更/);
assert.equal(scrollOptions.smoothWheel, true);
assert.equal(scrollOptions.respectReducedMotion, true);
assert.ok(scrollOptions.lerp > 0 && scrollOptions.lerp < 0.15);
assert.equal($('.live-workbench-frame').getAttribute('src'), '/demo.html?lang=zh');
assert.equal(document.querySelectorAll('.workbench').length, 0, 'The recreated interface must be removed');
click('#feature-stage');
assert.equal($('#feature-stage').getAttribute('aria-pressed'), 'true');
click('[data-graph="feature"][data-commit="1"]');
assert.match($('[data-detail="feature"]').textContent, /useRepository.ts/);
click('[data-resolve="incoming"]');
assert.match($('#conflict-result').textContent, /<nav>/);
click('[data-resolve="current"]');
assert.match($('#conflict-result').textContent, /<div>/);
assert.equal($('[data-resolve="incoming"]').getAttribute('aria-pressed'), 'false');
click('[data-theme-option="light"]');
assert.equal($('.theme-preview').dataset.theme, 'light');
$('#command-search').value = '不存在的命令';
$('#command-search').dispatchEvent(new window.Event('input', { bubbles: true }));
assert.match($('#command-results').textContent, /没有找到命令/);
$('#command-search').value = '仓库';
$('#command-search').dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(document.querySelectorAll('[data-command]').length, 3);
click('[data-command="0"]');
assert.match($('.command-feedback').textContent, /打开仓库/);

assert.equal($('.platform-card a').getAttribute('href'), 'https://example.com/gitcrest.exe');
assert.equal(document.querySelectorAll('.platform-card a').length, 1, 'Unsafe release URLs must not create links');
click('[data-legal="privacy"]');
assert.equal($('.legal-dialog').open, true);
assert.equal(stopped, true);
click('.dialog-close');
assert.equal($('.legal-dialog').open, false);
assert.equal(stopped, false);
click('.menu-toggle');
assert.equal($('.menu-toggle').getAttribute('aria-expanded'), 'true');
assert.equal($('main').inert, true);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal($('.menu-toggle').getAttribute('aria-expanded'), 'false');

click('#language-switch');
assert.equal(document.documentElement.lang, 'en');
assert.match($('h1').textContent, /See every change/);
assert.equal($('.live-workbench-frame').getAttribute('src'), '/demo.html?lang=en');
assert.match(document.title, /Commit with confidence/);
assert.equal(window.localStorage.getItem('gitcrest-language'), 'en');
assert.equal(new URL(window.location.href).searchParams.get('lang'), 'en');
assert.equal(document.querySelectorAll('.faq-list details').length, 6);
assert.match($('.faq-list').textContent, /Which platforms/);
assert.equal($('#language-switch').textContent.trim(), '中文');
click('#language-switch');
assert.equal(document.documentElement.lang, 'zh-CN');
assert.equal($('.menu-toggle').getAttribute('aria-expanded'), 'false');
assert.equal(document.querySelectorAll('a[href="#"]').length, 0);
assert.ok([...document.querySelectorAll('img')].every(img => img.hasAttribute('alt')));

window.fetch = async () => { throw new Error('Network unavailable'); };
await window.eval('loadReleases()');
assert.match($('#release-feedback').textContent, /加载失败/);
window.fetch = async () => ({ ok: true, json: async () => ({ windows: null, macos: null, linux: null }) });
click('#retry-releases');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal($('#release-feedback').textContent, '');
assert.equal(document.querySelectorAll('.platform-card button:disabled').length, 3);
window.history.replaceState({}, '', '/missing-page');
window.eval('render()');
assert.match($('h1').textContent, /这一页还没有提交/);
assert.equal($('.not-found a.button').getAttribute('href'), '/?lang=zh');
dom.window.close();
console.log('Passed: bilingual metadata and persistence; real client iframe and language synchronization; graph inspection; conflict choices; command search and empty state; theme preview; menu and dialog focus state; safe download links, loading failure and retry; branded 404.');
