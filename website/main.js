import Lenis from './public/vendor/lenis.mjs';

const basePath = import.meta.env.BASE_URL;
const appVersion = typeof __GITCREST_APP_VERSION__ !== 'undefined' ? __GITCREST_APP_VERSION__ : '0.1.7';
const publicSiteUrl = typeof __GITCREST_PUBLIC_URL__ !== 'undefined' ? __GITCREST_PUBLIC_URL__ : 'https://liulewis67-ops.github.io/GitCrest/';

const copy = {
  zh: {
    title: 'GitCrest · 看清变更，从容提交 — 代码感知 Diff 与桌面 Git 工作台',
    description: 'GitCrest 是一款基于 Rust 本地核心的跨平台桌面 Git 工作台，支持 Windows、macOS 与 Linux。提供代码感知结构 Diff、按行/代码块暂存、清晰的提交历史分支图与三栏合并冲突解决，开源免费且零云端追踪。',
    keywords: 'GitCrest, Git 客户端, 桌面 Git 工作台, Git GUI, 代码感知 Diff, 代码结构 Diff, 提交历史图, 分支图, 三栏冲突解决, 合并冲突工具, 按行暂存, Rust Git 客户端, Windows Git 客户端, macOS Git 客户端, Linux Git 客户端, 开源 Git 客户端',
    ogLocale: 'zh_CN',
    ogImageAlt: 'GitCrest 桌面 Git 工作台界面预览：代码感知 Diff 与提交历史',
    featureList: ['按函数与代码结构定位改动的代码感知 Diff', '按行或代码块精准暂存与提交', '清晰直观的提交历史与多分支图谱', '当前版本、合并结果与传入版本三栏冲突解决', '命令搜索与可自定义键盘快捷键', 'Rust 本地核心引擎，零云端追踪', '原生中英文界面与深浅主题切换'],
    skip: '跳到主要内容', features: '功能', workflow: '工作流', faq: '常见问题', download: '下载 GitCrest', tryDemo: '体验交互演示', menu: '打开导航', navPrimary: '主导航', navMobile: '移动导航', close: '关闭',
    eyebrow: '面向开发者的桌面 Git 工作台', hero: ['看清每一次变更', '从容完成每一次提交'], sub: '读懂代码差异，理清分支历史，确认每一次合并。', subDetail: '从检查改动到完成提交，在同一个工作台里接着思考。',
    specs: ['Rust 本地核心', '代码结构 Diff', '三栏冲突解决', '零云端追踪'],
    proof: '支持 Windows、macOS 与 Linux', proofSub: 'Windows、macOS 与 Linux 桌面客户端', scroll: '探索工作台', demo: '工作台演示', demoHint: '与桌面客户端共用界面代码，可切换视图与选择文件。',
    workspace: '工作区', history: '提交历史', changes: '变更', staged: '已暂存', stage: '暂存此变更', unstage: '取消暂存', commit: '提交变更', committed: '演示提交已完成', reset: '重新体验', message: '重构导航，保持上下文', branch: '当前分支', sample: '真实客户端界面 · 仅使用内存示例数据，不会访问你的仓库。',
    tagline: [['先看清变更，'], ['再提交有意图的代码。']], taglineLabel: '让每个提交，都有清楚的来由',
    overview: [['diff', '读懂变更', '按结构阅读，按需暂存'], ['history', '追溯历史', '沿着分支，找到上下文'], ['conflicts', '确认合并', '比较两边，检查结果']], overviewLabel: '探索核心功能',
    diffKicker: '01 / 代码感知 Diff', diffTitle: ['看懂变更', '精准提交'], diffBody: '顺着函数和代码结构定位改动，再选出属于这次提交的部分。让一个提交，说明一件事。', diffBullets: ['按代码结构定位改动', '按行或代码块选择暂存', '并排检查修改前后的代码'], diffAction: '试着暂存这段变更',
    historyKicker: '02 / 提交历史', historyTitle: ['看清分支', '理解每次提交'], historyBody: '分支从哪里分出，又在哪里汇合？沿着提交图追溯，点开一次提交，就能查看对应改动。', historyBullets: ['在图中追踪分支走向', '选择提交，查看文件变化', '保留浏览位置，继续检查'], graphHint: '选择一条提交，查看对应的文件改动', files: '变更文件', author: '作者',
    conflictKicker: '03 / 冲突处理', conflictTitle: ['两边的改动', '一个清晰的结果'], conflictBody: '把当前版本与传入版本放在一起比较，在中间检查合并结果。保留哪些内容，由你逐处决定。', current: '当前版本', result: '合并结果', incoming: '传入版本', useCurrent: '采用当前版本', useIncoming: '采用传入版本', resolved: '已更新结果，请继续检查', conflictHint: '选择一侧的版本，查看合并结果',
    workflowKicker: '从检查到提交', workflowTitle: '三步，完成一次清晰的提交', workflowSub: '先理解改动，再划定范围，最后写下这次提交的意图。', steps: [['检查变更', '对照代码，确认改了什么。'], ['选择暂存', '划定范围，只纳入相关改动。'], ['写下提交', '说明原因，让历史有据可循。']],
    personalKicker: '按你的习惯工作', personalTitle: '常用操作顺手，代码阅读舒适', personalSub: '用键盘连接操作，用主题调整阅读环境。把工作台调到适合自己的状态。', keyboard: '常用操作，抬手就到', keyboardBody: '搜索命令，或用熟悉的快捷键直接执行。', theme: '选一个舒服的阅读环境', themeBody: '深色或浅色，让代码在你习惯的明暗中呈现。', light: '浅色', dark: '深色', themeHint: '切换预览主题', command: '试试搜索命令', commandPlaceholder: '搜索命令…', commands: ['打开仓库', '克隆仓库', '初始化仓库', '切换工作区', '切换提交历史'], emptyCommands: '没有找到命令，试试“仓库”。', commandSelected: '已选择演示命令',
    faqKicker: '开始之前', faqTitle: '几个常见问题', faqIntro: '关于系统支持、现有仓库和日常操作，你关心的细节在这里。', faqs: [
      ['支持哪些系统？', 'GitCrest 面向 Windows、macOS 和 Linux。各平台可用的安装包以本页下载区为准。'],
      ['可以打开现有的 Git 仓库吗？', '可以直接打开本地 Git 工作树，也可以克隆仓库后开始使用。'],
      ['可以只提交部分改动吗？', '可以。在 Diff 中按行或代码块选择要暂存的内容，再创建提交。未暂存的改动保留在工作区。'],
      ['如何处理合并冲突？', '在独立的冲突处理界面中比较当前版本和传入版本，编辑合并结果，再检查和保存。'],
      ['支持键盘操作吗？', '支持。命令搜索和可自定义的快捷键帮助你完成常用操作。'],
      ['可以切换语言和主题吗？', '客户端提供中英文界面与深浅主题。此页面的语言可通过导航栏中的按钮切换。'],
    ],
    downloadKicker: '开始使用 GitCrest', downloadTitle: ['下一次提交', '从这里开始。'], downloadBody: '选择你的系统，从一个熟悉的仓库开始。', available: '下载安装包', unavailable: '安装包尚未发布', releaseLoading: '正在检查安装包', releaseError: '安装包信息加载失败。请重试。', retry: '重新加载', platformNote: '尚未发布的平台将在安装包就绪后开放下载。', localBuild: 'Windows 预览安装包',
    footer: '清晰的变更，专注的工作流。', privacy: '隐私说明', terms: '使用说明', top: '回到顶部', privacyText: '此宣传页不包含账号、表单、广告追踪或分析脚本。页面仅在你的浏览器中保存语言选择。交互演示使用示例数据，不会访问本地仓库。点击安装包链接后，下载由该链接所指向的服务器提供。', termsText: '此页面用于介绍 GitCrest。代码与提交演示为交互示意，不会执行真实的 Git 操作。安装包的可用性以下载区显示为准；本页不提供付费订阅或服务承诺。', notFound: '这一页还没有提交。', notFoundBody: '你访问的地址不存在，回到 GitCrest 继续探索。', home: '返回首页',
  },
  en: {
    title: 'GitCrest · See every change. Commit with confidence — Desktop Git Workbench',
    description: 'GitCrest is a cross-platform desktop Git workbench powered by a local Rust core for Windows, macOS, and Linux. Review code-aware structural diffs, stage by line or hunk, trace commit graphs, and resolve merge conflicts in a 3-way workspace.',
    keywords: 'GitCrest, Git client, desktop Git workbench, Git GUI, code-aware diff, structural diff, commit graph, branch history, 3-way merge conflict resolver, line staging, hunk staging, Rust Git client, Windows Git client, macOS Git client, Linux Git client, open source Git client',
    ogLocale: 'en_US',
    ogImageAlt: 'GitCrest desktop Git workbench interface preview showing code-aware diff and commit history',
    featureList: ['Code-aware structural diff with symbol navigation', 'Line-level and hunk-level selective staging', 'Interactive commit history and multi-branch graph', 'Continuous 3-way merge conflict resolver', 'Command palette search and customizable keyboard shortcuts', 'Local Rust core engine with zero telemetry', 'Bilingual Chinese/English UI with light and dark themes'],
    skip: 'Skip to content', features: 'Features', workflow: 'Workflow', faq: 'FAQ', download: 'Download GitCrest', tryDemo: 'Try interactive demo', menu: 'Open navigation', navPrimary: 'Primary navigation', navMobile: 'Mobile navigation', close: 'Close',
    eyebrow: 'A desktop Git workbench for developers', hero: ['See every change.', 'Commit with confidence.'], sub: 'Read the diff. Follow the branches. Review the merge.', subDetail: 'One workbench, from your first review to the final commit.',
    specs: ['Local Rust Core', 'Code-Aware Diff', '3-Way Merge', 'Zero Telemetry'],
    proof: 'For Windows, macOS, and Linux', proofSub: 'A desktop client for Windows, macOS, and Linux', scroll: 'Explore the workbench', demo: 'Workbench demo', demoHint: 'The actual desktop interface. Switch views and select a file.',
    workspace: 'Workspace', history: 'History', changes: 'Changes', staged: 'Staged', stage: 'Stage this change', unstage: 'Unstage change', commit: 'Commit changes', committed: 'Demo commit complete', reset: 'Try again', message: 'Refactor navigation, preserve context', branch: 'Current branch', sample: 'Actual client UI. Sample data stays in memory. Your repositories stay untouched.',
    tagline: [['Understand the change.'], ['Commit with clear intent.']], taglineLabel: 'Give every commit a reason.',
    overview: [['diff', 'Read the change', 'Follow the structure. Stage what belongs.'], ['history', 'Find the context', 'Trace branches and inspect commits.'], ['conflicts', 'Review the merge', 'Compare both sides. Check the result.']], overviewLabel: 'Explore the core features',
    diffKicker: '01 / Code structure', diffTitle: ['Read the change.', 'Stage with intent.'], diffBody: 'Find changes through the structure of your code. Then stage only what belongs together. Give each commit one clear purpose.', diffBullets: ['Locate changes by code structure', 'Stage specific lines or blocks', 'Compare the code before and after'], diffAction: 'Try staging this change',
    historyKicker: '02 / Commit history', historyTitle: ['Follow the branches.', 'Find the context.'], historyBody: 'Where did a branch begin? Where did it merge? Follow the graph, select a commit, and inspect the changes behind it.', historyBullets: ['Trace branches through the graph', 'Inspect the files in each commit', 'Keep your place as you explore'], graphHint: 'Select a commit to inspect its file changes', files: 'Changed files', author: 'Author',
    conflictKicker: '03 / Conflict resolution', conflictTitle: ['Compare both sides.', 'Review one result.'], conflictBody: 'Compare the current and incoming versions, with the result between them. Decide what to keep, then review the code you will merge.', current: 'Current', result: 'Result', incoming: 'Incoming', useCurrent: 'Use current', useIncoming: 'Use incoming', resolved: 'Result updated. Ready for review.', conflictHint: 'Choose either version to preview the result',
    workflowKicker: 'From review to commit', workflowTitle: 'Three steps. One purposeful commit.', workflowSub: 'Understand the change, choose its scope, and leave a clear record of why it matters.', steps: [['Review the change', 'Compare the code. See exactly what changed.'], ['Choose the scope', 'Stage the changes that belong together.'], ['Capture the intent', 'Explain the reason. Leave a useful history.']],
    personalKicker: 'Work your way', personalTitle: 'Familiar actions. Comfortable reading.', personalSub: 'Move between actions with the keyboard. Choose the theme that suits the way you read.', keyboard: 'The next action, at your fingertips.', keyboardBody: 'Search for a command, or go straight to it with a shortcut.', theme: 'A comfortable place to read.', themeBody: 'Light or dark. Put your code in a familiar setting.', light: 'Light', dark: 'Dark', themeHint: 'Change the preview theme', command: 'Try command search', commandPlaceholder: 'Search commands…', commands: ['Open repository', 'Clone repository', 'Initialize repository', 'Switch to workspace', 'Switch to history'], emptyCommands: 'No commands found. Try “repository”.', commandSelected: 'Demo command selected',
    faqKicker: 'Before you begin', faqTitle: 'A few common questions.', faqIntro: 'Platforms, existing repositories, and everyday operations. Here are the details.', faqs: [
      ['Which platforms are supported?', 'GitCrest targets Windows, macOS, and Linux. Check the download section for available installers on each platform.'],
      ['Can I open my existing Git repositories?', 'Open a local Git working tree directly, or clone a repository to get started.'],
      ['Can I commit only part of a change?', 'Yes. Stage specific lines or blocks in the diff, then create a commit. Unstaged changes stay in your working tree.'],
      ['How does conflict resolution work?', 'A dedicated conflict window lets you compare current and incoming versions, edit the result, then review and save it.'],
      ['Can I work with the keyboard?', 'Yes. Command search and customizable keyboard shortcuts support common operations.'],
      ['Can I change the language and theme?', 'The client offers Chinese and English interfaces, with light and dark themes. Use the language button in this page’s navigation to switch the website language.'],
    ],
    downloadKicker: 'Get started with GitCrest', downloadTitle: ['Your next commit', 'starts here.'], downloadBody: 'Choose your platform. Start with a repository you know.', available: 'Download installer', unavailable: 'Installer not published yet', releaseLoading: 'Checking installers', releaseError: 'Could not load installer information. Please try again.', retry: 'Try again', platformNote: 'Downloads open as installers become available for each platform.', localBuild: 'Windows preview installer',
    footer: 'Clear changes. Focused workflows.', privacy: 'Privacy notice', terms: 'Site terms', top: 'Back to top', privacyText: 'This marketing page has no accounts, forms, advertising trackers, or analytics scripts. It stores only your language preference in your browser. Interactive demos use sample data and do not access local repositories. Installer downloads are served by the server linked in the download section.', termsText: 'This page introduces GitCrest. Code and commit examples are interactive illustrations and do not perform real Git operations. Installer availability is shown in the download section. This page does not offer paid subscriptions or service guarantees.', notFound: 'This page is not in the history.', notFoundBody: 'That address does not exist. Head back to GitCrest and keep exploring.', home: 'Back to home',
  },
};

const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
let savedLang;
try { savedLang = localStorage.getItem('gitcrest-language'); } catch { /* Storage may be disabled. */ }
let lang = params.get('lang') === 'en' || (params.get('lang') !== 'zh' && savedLang === 'en') ? 'en' : 'zh';
let t = copy[lang];
let cleanup = [];
let releases = null;
let releaseFailure = false;
let lenis;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Phosphor regular icon paths. Brand artwork is the project's existing SVG.
const paths = {
  download: '<path d="M128 24v144m-48-48 48 48 48-48M40 168v40a8 8 0 0 0 8 8h160a8 8 0 0 0 8-8v-40"/>',
  arrow: '<path d="M40 128h176m-72-72 72 72-72 72"/>',
  branch: '<circle cx="72" cy="48" r="24"/><circle cx="184" cy="64" r="24"/><circle cx="72" cy="208" r="24"/><path d="M72 72v112m112-96v16a40 40 0 0 1-40 40h-32a40 40 0 0 0-40 40"/>',
  check: '<path d="m40 128 56 56L216 64"/>',
  code: '<path d="m64 72-56 56 56 56m128-112 56 56-56 56M152 40l-48 176"/>',
  keyboard: '<rect x="24" y="56" width="208" height="144" rx="16"/><path d="M56 88h8m32 0h8m32 0h8m32 0h24M56 120h16m32 0h8m32 0h8m32 0h16M56 160h16m32 0h64m24 0h8"/>',
  sun: '<circle cx="128" cy="128" r="48"/><path d="M128 16v16m0 192v16M16 128h16m192 0h16M48 48l12 12m136 136 12 12M48 208l12-12M196 60l12-12"/>',
  moon: '<path d="M216 152A96 96 0 0 1 104 40a96 96 0 1 0 112 112Z"/>',
  search: '<circle cx="112" cy="112" r="72"/><path d="m164 164 60 60"/>',
  folder: '<path d="M24 64a8 8 0 0 1 8-8h64l32 32h96a8 8 0 0 1 8 8v112a8 8 0 0 1-8 8H32a8 8 0 0 1-8-8Z"/>',
  file: '<path d="M144 32H56a8 8 0 0 0-8 8v176a8 8 0 0 0 8 8h144a8 8 0 0 0 8-8V96Zm0 0v64h64"/>',
  up: '<path d="M128 216V40m-72 72 72-72 72 72"/>',
  globe: '<circle cx="128" cy="128" r="96"/><ellipse cx="128" cy="128" rx="40" ry="96"/><path d="M32 128h192"/>',
  windows: '<path d="m32 56 80-12v76H32Zm96-14 96-14v92h-96ZM32 136h80v76l-80-12Zm96 0h96v92l-96-14Z"/>',
  apple: '<path d="M132 56c-2-22 16-40 36-40 2 22-14 40-36 40ZM128 76c24 0 32-16 56-8a56 56 0 0 1 24 16c-40 24-32 72 8 88-8 24-32 60-48 60-16 0-24-12-40-12s-24 12-40 12c-24 0-64-64-64-104s24-64 56-64c16 0 32 12 48 12Z"/>',
  linux: '<path d="M88 136c-8-24-8-112 40-112s48 88 40 112l32 64-40 24-32-16-32 16-40-24Zm16-80v8m48-8v8m-48 24 24 16 24-16M88 136l40 32 40-32"/>',
  cpu: '<rect x="48" y="48" width="160" height="160" rx="16"/><rect x="96" y="96" width="64" height="64" rx="8"/><path d="M96 48V24m64 24V24M96 232v-24m64 24v-24M48 96H24m24 64H24m208-64h-24m24 64h-24"/>',
  shield: '<path d="M40 112V56a8 8 0 0 1 8-8h160a8 8 0 0 1 8 8v56c0 88-88 112-88 112S40 200 40 112Z"/><path d="m96 128 24 24 44-48"/>',
  layers: '<path d="m32 128 96 56 96-56M32 172l96 56 96-56M128 28l96 56-96 56-96-56Z"/>',
};
function icon(name, cls = '') { return `<svg class="icon ${cls}" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.code}</svg>`; }
const brand = () => `<a class="brand title-2" href="${basePath}?lang=${lang}" aria-label="GitCrest"><img src="${basePath}assets/favicon.svg" width="32" height="32" alt="" />GitCrest</a>`;
const label = (s) => `<span class="eyebrow caption-3">${s}</span>`;
const primary = () => `<a class="button button-md primary" href="#download">${icon('download')}${t.download}${icon('arrow', 'button-arrow')}</a>`;
const bullets = (items) => `<ul class="benefit-list body-6">${items.map(s => `<li>${icon('check')}${s}</li>`).join('')}</ul>`;
const windowDots = () => '<span class="window-chrome-dots" aria-hidden="true"><i></i><i></i><i></i></span>';

const commits = [
  ['Refactor navigation, preserve context', 'navigation.ts', 'a8d32f1', '+24', '−12', 'feature/navigation'],
  ['Keep repository selection on return', 'useRepository.ts', 'c7b619e', '+18', '−6', 'main'],
  ['Merge branch feature/sidebar', 'Sidebar.tsx', '82f30bc', '+42', '−16', ''],
  ['Add keyboard shortcuts', 'shortcuts.ts', 'f94c02a', '+36', '−4', 'feature/shortcuts'],
  ['Improve diff reading context', 'DiffView.tsx', 'e1238bd', '+28', '−9', ''],
  ['Create the workbench', 'App.tsx', '31ba7c2', '+64', '−0', ''],
];
const codeSets = [
  { old: ['export function navigate(path) {', '  setActiveView(path);', '  resetRepository();', '  closeAllPanels();', '  return path;', '}'], next: ['export function navigate(path) {', '  const context = getContext();', '  setActiveView(path);', '  restoreRepository(context);', '  return { path, context };', '}'] },
  { old: ['export function useRepository() {', '  const repo = useState(null);', '  const select = setRepository;', '  return { repo, select };', '}'], next: ['export function useRepository() {', '  const repo = useSavedRepository();', '  const select = preserveContext;', '  return { repo, select };', '}'] },
  { old: ['export function Sidebar() {', '  return (', '    <nav>', '      <RepositoryList />', '    </nav>', '  );', '}'], next: ['export function Sidebar() {', '  return (', '    <nav aria-label="Repositories">', '      <RepositoryList keepPosition />', '    </nav>', '  );', '}'] },
];

function highlightLine(raw) {
  let s = escapeHTML(raw);
  if (/^\s*\/\//.test(raw)) return `<span class="tok-cm">${s}</span>`;
  s = s.replace(/\b(export|function|const|return)\b/g, '<span class="tok-kw">$1</span>');
  s = s.replace(/\b(navigate|getContext|setActiveView|restoreRepository|Navigation)\b(?=\()/g, '<span class="tok-fn">$1</span>');
  s = s.replace(/(&lt;\/?(?:div|nav|Home)\s*\/?&gt;)/g, '<span class="tok-tag">$1</span>');
  return s;
}

function codeLines(lines, side) {
  return lines.map((line, i) => `<div class="code-line ${i > 0 && i < lines.length - 2 ? side : ''}"><span class="line-number">${i + 1}</span><code>${highlightLine(line)}</code></div>`).join('');
}

function graphLaneSvg(index) {
  const mainX = 11;
  const featX = 25;
  const parts = [];
  // Main vertical backbone
  if (index === 0) parts.push(`<line x1="${mainX}" y1="27" x2="${mainX}" y2="54" stroke="#6db6d8" stroke-opacity="0.48" stroke-width="2"/>`);
  else if (index === commits.length - 1) parts.push(`<line x1="${mainX}" y1="0" x2="${mainX}" y2="27" stroke="#6db6d8" stroke-opacity="0.48" stroke-width="2"/>`);
  else parts.push(`<line x1="${mainX}" y1="0" x2="${mainX}" y2="54" stroke="#6db6d8" stroke-opacity="0.48" stroke-width="2"/>`);

  // Feature lane curve around merge commit (index 2) and feature commit (index 3)
  if (index === 2) {
    parts.push(`<path d="M ${mainX} 27 C ${mainX} 42, ${featX} 38, ${featX} 54" fill="none" stroke="#7ee7b0" stroke-opacity="0.65" stroke-width="2"/>`);
  } else if (index === 3) {
    parts.push(`<path d="M ${featX} 0 L ${featX} 27 C ${featX} 42, ${mainX} 38, ${mainX} 54" fill="none" stroke="#7ee7b0" stroke-opacity="0.65" stroke-width="2"/>`);
  }

  // Commit node
  const cx = index === 3 ? featX : mainX;
  const fill = index === 2 ? '#d4b477' : index === 3 ? '#1b212a' : index === 0 ? '#5fd0d4' : '#1b212a';
  const stroke = index === 2 ? '#d4b477' : index === 3 ? '#7ee7b0' : '#6db6d8';
  parts.push(`<circle cx="${cx}" cy="27" r="4.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
  return `<svg class="graph-lane-svg" viewBox="0 0 34 54" aria-hidden="true">${parts.join('')}</svg>`;
}

function graphMarkup(id) {
  return `<div class="commit-list" role="group" aria-label="${t.history}">${commits.map((c, i) => `<button class="commit-row ${i === 0 ? 'selected' : ''}" data-graph="${id}" data-commit="${i}" aria-pressed="${i === 0}">${graphLaneSvg(i)}<span class="commit-text"><span class="body-5">${c[0]}</span><span class="caption-5">GitCrest · ${c[2]}</span></span>${c[5] ? `<span class="branch-label caption-5 ${c[5] === 'main' ? 'is-main' : ''}">${c[5]}</span>` : ''}</button>`).join('')}</div>`;
}

function appDemo() {
  return `<div class="live-workbench" id="workbench"><iframe class="live-workbench-frame" src="${basePath}demo.html?lang=${lang}" title="${t.demo}" loading="lazy" referrerpolicy="same-origin"></iframe></div>`;
}

function platformCards() {
  return ['windows', 'macos', 'linux'].map((os) => {
    const name = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }[os];
    const url = releases?.[os];
    const safe = typeof url === 'string' && (/^https:\/\//.test(url) || /^\/downloads\//.test(url));
    return `<article class="platform-card"><div class="platform-name heading-6">${icon(os === 'macos' ? 'apple' : os)}${name}</div><span class="caption-2">${os === 'windows' ? 'x64 · NSIS' : os === 'macos' ? 'Universal · DMG' : 'x64 · AppImage'}</span>${safe ? `<a class="button button-sm secondary" href="${escapeHTML(url)}" ${url.startsWith('/') ? 'download' : ''}>${icon('download')}${t.available}</a>` : `<button class="button button-sm secondary" disabled>${releases === null && !releaseFailure ? t.releaseLoading : t.unavailable}</button>`}</article>`;
  }).join('');
}

function updateSeoMetadata(isNotFound) {
  const htmlLang = lang === 'zh' ? 'zh-CN' : 'en';
  document.documentElement.lang = htmlLang;
  const setMeta = (selector, value) => { const el = document.querySelector(selector); if (el) el.setAttribute('content', value); };
  const pageUrl = `${publicSiteUrl}?lang=${lang}`;
  const socialImage = new URL('assets/social.png', publicSiteUrl).href;

  if (isNotFound) {
    document.title = '404 · GitCrest';
    setMeta('meta[name="robots"]', 'noindex,follow');
    return;
  }

  document.title = t.title;
  setMeta('meta[name="description"]', t.description);
  setMeta('meta[name="keywords"]', t.keywords);
  setMeta('meta[name="robots"]', 'index,follow,max-image-preview:large');
  setMeta('meta[property="og:title"]', t.title);
  setMeta('meta[property="og:description"]', t.description);
  setMeta('meta[property="og:url"]', pageUrl);
  setMeta('meta[property="og:locale"]', t.ogLocale);
  setMeta('meta[property="og:image:alt"]', t.ogImageAlt);
  setMeta('meta[name="twitter:title"]', t.title);
  setMeta('meta[name="twitter:description"]', t.description);
  setMeta('meta[name="twitter:image:alt"]', t.ogImageAlt);

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.setAttribute('href', pageUrl);

  const ldScript = document.querySelector('#structured-data');
  if (ldScript) {
    ldScript.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${publicSiteUrl}#website`,
          name: 'GitCrest',
          url: publicSiteUrl,
          inLanguage: ['zh-CN', 'en'],
          description: t.description,
        },
        {
          '@type': 'SoftwareApplication',
          '@id': `${publicSiteUrl}#software`,
          name: 'GitCrest',
          alternateName: 'GitCrest Desktop Git Workbench',
          applicationCategory: 'DeveloperApplication',
          applicationSubCategory: 'Version Control / Git Client',
          operatingSystem: 'Windows, macOS, Linux',
          softwareVersion: appVersion,
          url: publicSiteUrl,
          downloadUrl: 'https://github.com/liulewis67-ops/GitCrest/releases',
          codeRepository: 'https://github.com/liulewis67-ops/GitCrest',
          license: 'https://www.apache.org/licenses/LICENSE-2.0',
          isAccessibleForFree: true,
          inLanguage: ['zh-CN', 'en'],
          image: socialImage,
          screenshot: socialImage,
          description: t.description,
          keywords: t.keywords,
          featureList: t.featureList,
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
          },
        },
        {
          '@type': 'FAQPage',
          '@id': `${publicSiteUrl}#faq`,
          inLanguage: htmlLang,
          mainEntity: t.faqs.map(([question, answer]) => ({
            '@type': 'Question',
            name: question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: answer,
            },
          })),
        },
      ],
    });
  }
}

function render() {
  cleanup.forEach(fn => fn()); cleanup = [];
  t = copy[lang];
  if (![basePath, `${basePath}index.html`].includes(location.pathname)) {
    updateSeoMetadata(true);
    app.innerHTML = `<main class="not-found container">${brand()}${label('404')}<h1 class="heading-1">${t.notFound}</h1><p class="body-3">${t.notFoundBody}</p><a class="button button-md primary" href="${basePath}?lang=${lang}">${t.home}${icon('arrow')}</a></main>`;
    return;
  }
  const specIcons = ['cpu', 'code', 'layers', 'shield'];
  updateSeoMetadata(false);
  app.innerHTML = `
    <a class="skip-link button button-sm" href="#main">${t.skip}</a>
    <header class="site-header"><nav class="nav-shell" aria-label="${t.navPrimary}">${brand()}<div class="desktop-nav body-5"><a href="#features" data-nav="features">${t.features}</a><a href="#workflow" data-nav="workflow">${t.workflow}</a><a href="#faq" data-nav="faq">${t.faq}</a></div><div class="nav-actions"><button class="language-button button-sm" id="language-switch" aria-label="${lang === 'zh' ? 'Switch to English' : '切换至中文'}">${icon('globe')}<span>${lang === 'zh' ? 'EN' : '中文'}</span></button><a href="#download" class="button button-sm nav-download">${t.download}${icon('arrow')}</a><button class="menu-toggle" aria-label="${t.menu}" aria-expanded="false" aria-controls="mobile-menu"><span></span><span></span></button></div></nav></header>
    <div class="mobile-menu" id="mobile-menu" inert><nav aria-label="${t.navMobile}">${[['features', t.features], ['workflow', t.workflow], ['faq', t.faq], ['download', t.download]].map(([id, text], i) => `<a class="heading-4" href="#${id}" style="--order:${i}">${text}${icon('arrow')}</a>`).join('')}</nav><p class="caption-2">GitCrest / ${t.footer}</p></div>
    <main id="main" tabindex="-1">
    <section class="hero container" aria-labelledby="hero-heading"><div class="hero-copy">${label(`<span class="live-dot"></span>${t.eyebrow}`)}<h1 class="heading-1" id="hero-heading"><span>${t.hero[0]}</span><span>${t.hero[1]}</span></h1><p class="hero-sub body-3">${t.sub}</p><p class="hero-detail body-6">${t.subDetail}</p><div class="hero-actions">${primary()}<a class="button button-md ghost-button" href="#workbench">${t.tryDemo}</a></div><div class="hero-proof caption-2"><span class="proof-icons">${icon('windows')}${icon('apple')}${icon('linux')}</span><span>${t.proof}</span></div><div class="spec-strip">${t.specs.map((item, i) => `<span class="spec-pill">${icon(specIcons[i])}${item}</span>`).join('')}</div></div>
      <div class="hero-product reveal"><div class="workbench-stage"><div class="product-caption"><span class="caption-3"><span class="live-dot"></span>GITCREST / ${t.demo}</span><span class="caption-5">${t.demoHint}</span></div>${appDemo()}</div><p class="demo-disclaimer caption-5">${t.sample}</p></div><a class="scroll-cue caption-5" href="#features"><span class="scroll-line"></span>${t.scroll}${icon('arrow')}</a>
    </section>
    <section class="tagline-section section section-divider container" id="features" aria-labelledby="tagline-heading"><div class="tagline-copy">${label(t.taglineLabel)}<h2 class="heading-2 tagline" id="tagline-heading">${t.tagline.map(line => `<span class="tagline-line">${line.map(phrase => `<span class="tagline-phrase">${phrase.split(lang === 'zh' ? '' : ' ').map(word => `<span class="tagline-word">${word}${lang === 'en' ? '&nbsp;' : ''}</span>`).join('')}</span>`).join('')}</span>`).join('')}</h2></div><nav class="feature-index" aria-label="${t.overviewLabel}">${t.overview.map(([id, title, description], i) => `<a href="#${id}"><span class="feature-index-number caption-4">0${i + 1}</span><span><span class="title-3">${title}</span><span class="caption-2">${description}</span></span>${icon('arrow')}</a>`).join('')}</nav></section>
    <section class="feature-section container section section-divider reveal" id="diff" aria-labelledby="diff-heading"><div class="feature-copy">${label(t.diffKicker)}<h2 class="heading-2" id="diff-heading">${t.diffTitle.map(s => `<span>${s}</span>`).join('')}</h2><p class="body-3">${t.diffBody}</p>${bullets(t.diffBullets)}</div><div class="feature-visual diff-visual"><div class="mini-toolbar caption-4">${windowDots()}${icon('code')} navigation.ts <span class="caption-5">Structure</span></div><div class="structure-layout"><div class="structure-tree caption-4"><span class="tree-label caption-5">SYMBOLS</span><span class="tree-function">ƒ navigate()</span><span class="tree-item">ƒ getContext()</span><span class="tree-item">ƒ restoreRepository()</span><div class="structure-note caption-5">${icon('check')} ${t.staged}</div></div><div class="structure-code"><div class="pane-label caption-5">navigation.ts <span>TS</span></div>${codeLines(codeSets[0].next, 'added')}<button class="hunk-button button-xsm" id="feature-stage" aria-pressed="false">${icon('check')}${t.stage}</button></div></div><p class="visual-caption caption-5">${icon('arrow')}${t.diffAction}</p></div></section>
    <section class="feature-section reverse container section section-divider reveal" id="history" aria-labelledby="history-heading"><div class="feature-copy">${label(t.historyKicker)}<h2 class="heading-2" id="history-heading">${t.historyTitle.map(s => `<span>${s}</span>`).join('')}</h2><p class="body-3">${t.historyBody}</p>${bullets(t.historyBullets)}</div><div class="feature-visual graph-visual"><div class="mini-toolbar caption-4">${windowDots()}${icon('branch')} main <span class="head-label caption-5">HEAD</span><span class="caption-5">${t.history}</span></div>${graphMarkup('feature')}<div class="graph-inspector" data-detail="feature"><div class="caption-5">a8d32f1 / GitCrest</div><div class="title-4">Refactor navigation, preserve context</div><div class="caption-4">${icon('file')} navigation.ts <span class="diff-stat-pill"><span class="green">+24</span><span class="red">−12</span></span></div></div><p class="visual-caption caption-5">${icon('arrow')}${t.graphHint}</p></div></section>
    <section class="conflict-section section section-divider container reveal" id="conflicts" aria-labelledby="conflict-heading"><div class="section-intro"><div>${label(t.conflictKicker)}<h2 class="heading-2" id="conflict-heading">${t.conflictTitle.join('<br />')}</h2></div><p class="body-3">${t.conflictBody}</p></div><div class="feature-visual conflict-visual"><div class="mini-toolbar caption-4">${windowDots()}${icon('code')} navigation.ts <span class="conflict-badge caption-5">1 conflict</span><span class="caption-5">${t.demo}</span></div><div class="conflict-panes"><div class="conflict-pane conflict-pane-current"><div class="pane-label caption-4">${t.current}<span class="caption-5">HEAD</span></div>${codeLines(['function Navigation() {', '  return (', '    <div>', '      <Home />', '    </div>', '  );', '}'], 'removed')}<button class="button button-sm secondary resolve-button" data-resolve="current" aria-pressed="false">${t.useCurrent}</button></div><div class="conflict-pane result-pane"><div class="pane-label caption-4"><span class="live-dot"></span>${t.result}<span class="caption-5">RESULT</span></div><div id="conflict-result" aria-live="polite">${codeLines(['function Navigation() {', '  return (', '', '    // choose a version', '', '  );', '}'], '')}</div><span class="result-status caption-5" id="result-status">${t.conflictHint}</span></div><div class="conflict-pane conflict-pane-incoming"><div class="pane-label caption-4">${t.incoming}<span class="caption-5">feature/nav</span></div>${codeLines(['function Navigation() {', '  return (', '    <nav>', '      <Home />', '    </nav>', '  );', '}'], 'added')}<button class="button button-sm secondary resolve-button" data-resolve="incoming" aria-pressed="false">${t.useIncoming}</button></div></div></div></section>
    <section class="workflow-section section section-divider container" id="workflow" aria-labelledby="workflow-heading"><div class="section-heading reveal">${label(t.workflowKicker)}<h2 class="heading-2" id="workflow-heading">${t.workflowTitle}</h2><p class="body-3">${t.workflowSub}</p></div><div class="workflow-grid">${t.steps.map(([title, body], i) => `<article class="workflow-step reveal"><div class="step-number caption-3">0${i + 1}</div><h3 class="heading-6">${title}</h3><p class="body-6">${body}</p><div class="step-mini caption-4">${i === 0 ? `<div class="step-mini-row">${icon('file')} navigation.ts <span class="git-badge m">M</span></div><div class="step-mini-row">${icon('file')} Sidebar.tsx <span class="git-badge a">A</span></div>` : i === 1 ? `<span class="step-check">${icon('check')} navigate()</span><span class="mini-code added">+ restoreRepository(context);</span>` : `<span class="mini-commit-msg">${t.message}</span><span class="mini-commit">${icon('check')} Commit</span>`}</div></article>`).join('')}</div></section>
    <section class="personal-section section section-divider container" aria-labelledby="personal-heading"><div class="section-heading reveal">${label(t.personalKicker)}<h2 class="heading-2" id="personal-heading">${t.personalTitle}</h2><p class="body-3">${t.personalSub}</p></div><div class="personal-grid"><article class="personal-card reveal"><div class="personal-copy"><div class="personal-icon-wrap">${icon('keyboard')}</div><h3 class="heading-5">${t.keyboard}</h3><p class="body-6">${t.keyboardBody}</p></div><div class="command-preview"><label class="command-input">${icon('search')}<input id="command-search" class="body-6" type="search" placeholder="${t.commandPlaceholder}" aria-label="${t.command}" autocomplete="off" /><kbd class="caption-5">Ctrl K</kbd></label><div id="command-results"></div><p class="command-feedback caption-5" aria-live="polite"></p></div></article><article class="personal-card reveal"><div class="personal-copy"><div class="personal-icon-wrap">${icon('sun')}</div><h3 class="heading-5">${t.theme}</h3><p class="body-6">${t.themeBody}</p></div><div class="theme-preview" data-theme="dark"><div class="theme-controls-wrap"><div class="theme-controls" role="group" aria-label="${t.themeHint}"><button class="button-xsm selected" data-theme-option="dark" aria-pressed="true">${icon('moon')}${t.dark}</button><button class="button-xsm" data-theme-option="light" aria-pressed="false">${icon('sun')}${t.light}</button></div></div><div class="theme-window"><div class="theme-window-bar caption-4">${windowDots()}${icon('branch')} feature/navigation <span class="live-dot"></span></div><div class="theme-code">${codeLines(codeSets[0].next.slice(0, 4), 'added')}</div></div></div></article></div></section>
    <section class="faq-section section section-divider container reveal" id="faq" aria-labelledby="faq-heading"><div class="faq-intro">${label(t.faqKicker)}<h2 class="heading-2" id="faq-heading">${t.faqTitle}</h2><p class="body-3">${t.faqIntro}</p></div><div class="faq-list">${t.faqs.map(([q, a], i) => `<details ${i === 0 ? 'open' : ''}><summary class="title-3">${q}<span class="faq-plus" aria-hidden="true"></span></summary><p class="body-6">${a}</p></details>`).join('')}</div></section>
    <section class="download-section section container reveal" id="download" aria-labelledby="download-heading"><div class="download-stage"><div class="download-mark" aria-hidden="true"><img src="${basePath}assets/favicon.svg" width="64" height="64" alt="" /></div>${label(t.downloadKicker)}<h2 class="heading-1" id="download-heading">${t.downloadTitle.join('<br />')}</h2><p class="body-3">${t.downloadBody}</p><div class="platform-grid" aria-live="polite">${platformCards()}</div><div id="release-feedback">${releaseFailure ? `<p class="body-6">${t.releaseError} <button class="text-button button-sm" id="retry-releases">${t.retry}</button></p>` : ''}</div><p class="caption-5 platform-note">${t.platformNote}</p></div></section>
    </main><footer class="site-footer container"><div class="footer-main">${brand()}<p class="caption-2">${t.footer}</p><a class="back-top caption-2" href="#main">${t.top}${icon('up')}</a></div><div class="footer-bottom caption-5"><span>GitCrest <span class="footer-dot">·</span> ${t.proofSub}</span><div><button class="text-button caption-5" data-legal="privacy">${t.privacy}</button><button class="text-button caption-5" data-legal="terms">${t.terms}</button><span>中文 / EN</span></div></div></footer>
    <dialog class="legal-dialog" aria-labelledby="legal-title" data-lenis-prevent><button class="dialog-close button button-sm secondary">${t.close} ×</button><h2 class="heading-5" id="legal-title"></h2><p class="body-3" id="legal-content"></p></dialog>
    <div class="site-progress" aria-hidden="true"></div>`;
  bindInteractions();
  setupMotion();
  renderCommands('');
}

function renderCommands(query) {
  const results = document.querySelector('#command-results');
  if (!results) return;
  const keys = ['Ctrl O', 'Ctrl Shift O', 'Ctrl N', 'Ctrl 1', 'Ctrl 2'];
  const filtered = t.commands.map((text, i) => ({ text, i })).filter(c => c.text.toLowerCase().includes(query.trim().toLowerCase()));
  results.innerHTML = filtered.length ? filtered.map(c => `<button class="command-row caption-4" data-command="${c.i}">${icon(c.i < 3 ? 'folder' : 'code')}<span>${c.text}</span><kbd class="caption-5">${keys[c.i]}</kbd></button>`).join('') : `<p class="caption-2 command-empty">${t.emptyCommands}</p>`;
  results.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => {
    document.querySelector('.command-feedback').textContent = `${t.commandSelected}: ${t.commands[Number(button.dataset.command)]}`;
  }));
}

function bindInteractions() {
  document.querySelector('#language-switch').addEventListener('click', () => {
    const previous = window.scrollY;
    lang = lang === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem('gitcrest-language', lang); } catch { /* Optional persistence. */ }
    const url = new URL(location.href); url.searchParams.set('lang', lang); history.replaceState({}, '', url);
    render();
    lenis?.resize();
    window.scrollTo(0, previous);
    document.querySelector('#language-switch')?.focus({ preventScroll: true });
  });

  const toggle = document.querySelector('.menu-toggle');
  const menu = document.querySelector('.mobile-menu');
  let menuOpen = false;
  function setMenu(open) {
    menuOpen = open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? t.close : t.menu);
    menu.inert = !open;
    document.body.classList.toggle('menu-open', open);
    document.querySelector('main').inert = open;
    document.querySelector('footer').inert = open;
    if (open) { lenis?.stop(); menu.querySelector('a').focus(); }
    else { lenis?.start(); toggle.focus({ preventScroll: true }); }
  }
  toggle.addEventListener('click', () => setMenu(!menuOpen));
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setMenu(false)));
  const onKey = (event) => {
    if (event.key === 'Escape' && menuOpen) setMenu(false);
    if (event.key === 'Tab' && menuOpen) {
      const focusable = [...document.querySelectorAll('.nav-actions button, .nav-actions a, .mobile-menu a')].filter(el => el.getClientRects().length);
      const index = focusable.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1).focus(); }
      else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0].focus(); }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      const input = document.querySelector('#command-search');
      lenis?.scrollTo(input, { offset: -200, onComplete: () => input.focus({ preventScroll: true }) });
      if (!lenis) input.focus();
    }
  };
  document.addEventListener('keydown', onKey); cleanup.push(() => document.removeEventListener('keydown', onKey));
  const onResize = () => { if (innerWidth > 760 && menuOpen) setMenu(false); };
  window.addEventListener('resize', onResize); cleanup.push(() => { window.removeEventListener('resize', onResize); if (menuOpen) { document.body.classList.remove('menu-open'); lenis?.start(); } });

  const frameHost = document.querySelector('.live-workbench');
  const frame = frameHost.querySelector('iframe');
  const resizeDemo = () => frameHost.style.setProperty('--demo-scale', String(frameHost.clientWidth / 1280));
  const demoObserver = new ResizeObserver(resizeDemo);
  demoObserver.observe(frameHost); resizeDemo();
  frame.addEventListener('load', () => frameHost.classList.add('loaded'));
  cleanup.push(() => demoObserver.disconnect());
  document.querySelector('#feature-stage').addEventListener('click', (e) => {
    const button = e.currentTarget; const pressed = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(pressed)); button.innerHTML = `${icon('check')}${pressed ? t.unstage : t.stage}`;
    document.querySelector('.diff-visual').classList.toggle('hunk-staged', pressed);
  });
  document.querySelectorAll('[data-graph]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.graph; const c = commits[Number(button.dataset.commit)];
    document.querySelectorAll(`[data-graph="${id}"]`).forEach(el => { el.classList.toggle('selected', el === button); el.setAttribute('aria-pressed', String(el === button)); });
    document.querySelector(`[data-detail="${id}"]`).innerHTML = id === 'hero' ? `${icon('file')}${c[1]} <span class="green">${c[3]}</span><span class="red">${c[4]}</span><code>${c[2]}</code>` : `<div class="caption-5">${c[2]} / GitCrest</div><div class="title-4">${c[0]}</div><div class="caption-4">${icon('file')}${c[1]} <span class="diff-stat-pill"><span class="green">${c[3]}</span><span class="red">${c[4]}</span></span></div>`;
  }));
  document.querySelectorAll('[data-resolve]').forEach(button => button.addEventListener('click', () => {
    const incoming = button.dataset.resolve === 'incoming';
    document.querySelector('#conflict-result').innerHTML = codeLines(['function Navigation() {', '  return (', `    <${incoming ? 'nav' : 'div'}>`, '      <Home />', `    </${incoming ? 'nav' : 'div'}>`, '  );', '}'], 'added');
    document.querySelectorAll('[data-resolve]').forEach(el => el.setAttribute('aria-pressed', String(el === button)));
    const status = document.querySelector('#result-status');
    status.textContent = `${t.resolved} · ${incoming ? t.incoming : t.current}`;
    status.classList.add('is-resolved');
  }));
  document.querySelector('#command-search').addEventListener('input', e => renderCommands(e.target.value));
  document.querySelectorAll('[data-theme-option]').forEach(button => button.addEventListener('click', () => {
    document.querySelector('.theme-preview').dataset.theme = button.dataset.themeOption;
    document.querySelectorAll('[data-theme-option]').forEach(el => { const selected = el === button; el.classList.toggle('selected', selected); el.setAttribute('aria-pressed', String(selected)); });
  }));
  const dialog = document.querySelector('.legal-dialog');
  document.querySelectorAll('[data-legal]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.legal;
    document.querySelector('#legal-title').textContent = t[key];
    document.querySelector('#legal-content').textContent = t[`${key}Text`];
    dialog.showModal(); lenis?.stop();
  }));
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => lenis?.start());
  dialog.addEventListener('click', e => { if (e.target === dialog) { const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); } });
  document.querySelector('#retry-releases')?.addEventListener('click', loadReleases);
}

function setupMotion() {
  const reveals = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('visible'); reveals.unobserve(entry.target); } }), { threshold: 0.08 });
  document.querySelectorAll('.reveal').forEach(el => reveals.observe(el));
  cleanup.push(() => reveals.disconnect());
  const nav = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { document.querySelectorAll('[data-nav]').forEach(link => { const active = link.dataset.nav === entry.target.id; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); }); } }), { rootMargin: '-15% 0px -65% 0px' });
  ['features', 'workflow', 'faq', 'download'].forEach(id => nav.observe(document.getElementById(id)));
  cleanup.push(() => nav.disconnect());
  const words = [...document.querySelectorAll('.tagline-word')];
  const tagline = document.querySelector('.tagline');
  let queued = false;
  const progress = document.querySelector('.site-progress');
  const update = () => {
    queued = false;
    const rect = tagline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (innerHeight * 0.82 - rect.top) / (innerHeight * 0.4 + rect.height * 0.4)));
    words.forEach((word, i) => { if (reduceMotion.matches || i / words.length <= ratio) word.classList.add('lit'); });
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  reduceMotion.addEventListener('change', onScroll);
  update(); cleanup.push(() => { window.removeEventListener('scroll', onScroll); reduceMotion.removeEventListener('change', onScroll); });
}

async function loadGitHubDownloads(repository) {
  if (!/^[\w-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`);
  if (response.status === 404) return {};
  if (!response.ok) throw new Error('GitHub release unavailable');
  const { assets } = await response.json();
  const assetPrefix = `https://github.com/${repository}/releases/download/`;
  function findInstaller(extension) {
    return assets.find(({ name, browser_download_url }) =>
      name?.endsWith(extension) && browser_download_url?.startsWith(assetPrefix)
    )?.browser_download_url;
  }
  return { windows: findInstaller('.exe'), macos: findInstaller('.dmg'), linux: findInstaller('.AppImage') };
}

async function loadReleases() {
  releaseFailure = false;
  releases = null;
  const grid = document.querySelector('.platform-grid');
  if (grid) grid.innerHTML = platformCards();
  try {
    const response = await fetch(`${basePath}releases.json`);
    if (!response.ok) throw new Error('Release manifest unavailable');
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid release manifest');
    releases = data;
    const { githubRepository, windows, macos, linux } = data;
    if (githubRepository && (!windows || !macos || !linux)) {
      const github = await loadGitHubDownloads(githubRepository);
      releases = { windows: windows || github.windows, macos: macos || github.macos, linux: linux || github.linux };
    }
  } catch { releaseFailure = true; releases ??= {}; }
  const currentGrid = document.querySelector('.platform-grid');
  if (currentGrid) currentGrid.innerHTML = platformCards();
  const feedback = document.querySelector('#release-feedback');
  if (feedback) { feedback.innerHTML = releaseFailure ? `<p class="body-6">${t.releaseError} <button class="text-button button-sm" id="retry-releases">${t.retry}</button></p>` : ''; document.querySelector('#retry-releases')?.addEventListener('click', loadReleases); }
}

document.documentElement.classList.add('js-motion');
render();
lenis = new Lenis({ autoRaf: true, anchors: { offset: -96 }, lerp: 0.085, smoothWheel: true, syncTouch: false, respectReducedMotion: true, prevent: node => node.hasAttribute?.('data-lenis-prevent') });
loadReleases();
window.addEventListener('pagehide', event => { if (!event.persisted) { cleanup.forEach(fn => fn()); lenis.destroy(); } });
