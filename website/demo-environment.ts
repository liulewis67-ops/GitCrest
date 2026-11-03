import type { GitCrestBridge, GitCrestEventEnvelope } from '../src/api/bridge';
import type { components } from '../src/api/schema';

type Schema = components['schemas'];
export const DEMO_REPO_ID = 'gitcrest-website-demo';
const ORIGIN = 'https://gitcrest-demo.invalid';
const timestamp = 1_793_606_400_000;
const oid = (n: number) => n.toString(16).padStart(40, '0');
const paths = ['src/navigation.ts', 'src/useRepository.ts', 'src/Sidebar.tsx'];

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => { data.delete(key); },
    setItem: (key, value) => { data.set(String(key), String(value)); },
  };
}

/** Browser-only data transport: no Rust process, filesystem, real repository, or credentials. */
export function installDemoEnvironment(target: Window & typeof globalThis) {
  const storage = createMemoryStorage();
  Object.defineProperty(target, 'localStorage', { configurable: true, value: storage });
  storage.setItem('gitcrest-locale', new URLSearchParams(target.location.search).get('lang') === 'en' ? 'en' : 'zh');
  storage.setItem('gitcrest-appearance-v1', JSON.stringify({ version: 1, mode: 'dark' }));
  storage.setItem('gitcrest-workspace-session-v1', JSON.stringify({
    openRepoIds: [DEMO_REPO_ID], activeRepoId: DEMO_REPO_ID,
    tabs: { [DEMO_REPO_ID]: { mode: 'changes', selectedFilePath: paths[0], selectedFileScope: 'workingTree', graphScrollTop: 0 } },
  }));
  storage.setItem('gitcrest-diff-view-v1', JSON.stringify({ layout: 'full', sideBySide: true, structureOutline: false }));

  const repository: Schema['Repository'] = {
    repoId: DEMO_REPO_ID, path: 'C:/Projects/GitCrest',
    head: oid(8), branch: 'main', detached: false, state: 'normal',
    isFavorite: true, lastAccessedAt: timestamp, availability: 'available',
  };
  let statusFiles: Schema['StatusFile'][] = paths.map((path, i) => ({
    path, indexStatus: i === 1 ? 'M' : '.', worktreeStatus: i === 1 ? '.' : 'M',
    kind: 'modified', categories: [i === 1 ? 'staged' : 'unstaged'], modeChanged: false,
  }));
  const historyEntries: Array<[string, number, number[]]> = [
    ['Keep repository context when switching views', 8, [7]],
    ['Merge branch feature/navigation', 7, [6, 5]],
    ['Refine the commit panel', 6, [4]],
    ['Preserve navigation state', 5, [4]],
    ['Add keyboard shortcuts', 4, [3]],
    ['Improve diff readability', 3, [2]],
    ['Add repository workspace', 2, [1]],
    ['Initialize GitCrest', 1, []],
  ];
  const commitList: Schema['CommitSummary'][] = historyEntries.map(([subject, id, parents]) => ({
    subject, oid: oid(id), parents: parents.map(oid),
    authorName: 'GitCrest Demo', authorEmail: 'demo@example.invalid',
    committedAtMs: timestamp - (8 - Number(id)) * 3_600_000,
  }));
  const branches: Schema['BranchSnapshot'] = {
    repoId: DEMO_REPO_ID, current: 'main', detached: false,
    branches: [
      { name: 'main', fullName: 'refs/heads/main', oid: oid(8), kind: 'local', isCurrent: true, isFavorite: true, upstream: 'origin/main', upstreamGone: false, ahead: 1, behind: 0 },
      { name: 'feature/navigation', fullName: 'refs/heads/feature/navigation', oid: oid(5), kind: 'local', isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
      { name: 'origin/main', fullName: 'refs/remotes/origin/main', oid: oid(7), kind: 'remote', isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
    ],
  };
  const tasks: Schema['TaskSnapshot'][] = [];
  const listeners = new Set<(event: GitCrestEventEnvelope) => void>();
  let eventId = 0;
  const emit = (type: GitCrestEventEnvelope['type']) => listeners.forEach(listener => listener({
    eventId: String(++eventId), protocolVersion: 1, type, occurredAtMs: timestamp + eventId,
    repoId: DEMO_REPO_ID, payload: { repoId: DEMO_REPO_ID },
  }));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-GitCrest-API-Version': '1' } });
  const unsupported = () => json({ error: { code: 'DEMO_ONLY', message: storage.getItem('gitcrest-locale') === 'zh' ? '此操作需要桌面客户端。网页演示只使用示例数据。' : 'This operation requires the desktop client. The web demo uses sample data only.' } }, 409);
  const task = (operation: string): Schema['TaskSnapshot'] => {
    const result: Schema['TaskSnapshot'] = {
      taskId: `demo-task-${tasks.length + 1}`, repoId: DEMO_REPO_ID, targetPath: null, resultRepoId: null, operation, status: 'succeeded', phase: 'Complete',
      progress: 100, message: null, errorCategory: null, logs: [], createdAtMs: timestamp, updatedAtMs: timestamp + 1, cancelRequested: false,
    };
    tasks.unshift(result); return result;
  };
  function diff(path: string, scope: Schema['DiffDocument']['scope']): Schema['DiffDocument'] {
    const index = Math.max(0, paths.indexOf(path));
    const versions = [
      [
        ['export function navigate(path: string) {', '  setActiveView(path);', '  resetRepository();', '  closeAllPanels();', '  return path;', '}', '', 'export function getContext() {', '  return { repository, selectedFile };', '}'],
        ['export function navigate(path: string) {', '  const context = getContext();', '  setActiveView(path);', '  restoreRepository(context);', '  return { path, context };', '}', '', 'export function getContext() {', '  return { repository, selectedFile };', '}'],
      ],
      [
        ['export function useRepository() {', '  const repository = useState(null);', '  return { repository };', '}'],
        ['export function useRepository() {', '  const repository = useSavedRepository();', '  return { repository };', '}'],
      ],
      [
        ['export function Sidebar() {', '  return <RepositoryList />;', '}'],
        ['export function Sidebar() {', '  return <RepositoryList keepPosition />;', '}'],
      ],
    ];
    const [before, after] = versions[index];
    return { repoId: DEMO_REPO_ID, path, originalPath: null, revision: `demo-${eventId}`, scope, changeKind: 'modified', status: 'text',
      hunks: [{ oldStart: 1, oldLines: before.length, newStart: 1, newLines: after.length,
        rows: after.map((line, i) => ({ kind: before[i] === line ? 'context' : 'change', oldLine: i < before.length ? i + 1 : null, newLine: i + 1, oldText: before[i] ?? null, newText: line })),
      }],
    };
  }

  const nativeFetch = target.fetch.bind(target);
  target.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), target.location.href);
    if (url.origin !== ORIGIN) {
      // Static application assets may load; no real API, external server, or AI provider may be contacted.
      if (url.origin === target.location.origin && !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      return unsupported();
    }
    const path = url.pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/version') return json({ name: 'gitcrest-core', version: '0.1.0', apiVersion: 1 });
    if (path.endsWith('/workflows/adopt')) return json({ adopted: false, task: null });
    if (path.endsWith('/identity')) return json({ name: 'GitCrest Demo', email: 'demo@example.invalid', nameScope: 'local', emailScope: 'local', resolved: true });
    if (path === '/api/v1/repositories') return json(method === 'POST' ? repository : [repository]);
    if (path === `/api/v1/repositories/${DEMO_REPO_ID}`) return json(repository);
    if (path.endsWith('/status')) return json({ repoId: DEMO_REPO_ID, refreshedAtMs: timestamp + eventId, files: statusFiles });
    if (path.endsWith('/branches')) return json(branches);
    if (path.endsWith('/refs')) return json({ repoId: DEMO_REPO_ID, head: repository.head, branch: repository.branch, detached: false, refs: branches.branches.map(({ name, fullName, oid, kind, upstream }) => ({ name, fullName, oid, kind, upstream })) });
    if (path.endsWith('/remotes')) return json({ repoId: DEMO_REPO_ID, defaultRemote: 'origin', remotes: [{ name: 'origin', fetchUrls: ['https://example.invalid/GitCrest.git'], pushUrls: ['https://example.invalid/GitCrest.git'], isDefault: true }] });
    if (path.endsWith('/worktrees')) return json({ repoId: DEMO_REPO_ID, worktrees: [{ path: repository.path, head: repository.head, branch: 'main', detached: false, locked: false, prunable: false, isCurrent: true }] });
    if (path.endsWith('/tags')) return json({ repoId: DEMO_REPO_ID, offset: 0, limit: 50, tags: [], nextOffset: null });
    if (path.endsWith('/stash')) return json({ repoId: DEMO_REPO_ID, stashes: [] });
    if (path.endsWith('/shelves')) return json([]);
    if (path === '/api/v1/tasks') return json(tasks);
    if (path.startsWith('/api/v1/tasks/')) return json(tasks.find(t => t.taskId === path.split('/')[4]) ?? tasks[0]);
    if (path.endsWith('/diff')) return json(diff(url.searchParams.get('path') || paths[0], path.includes('/commits/') ? 'commit' : url.searchParams.get('scope') === 'index' ? 'index' : 'workingTree'));
    if (path.endsWith('/commits') && method === 'GET') {
      const query = (url.searchParams.get('message') || '').toLowerCase();
      return json({ repoId: DEMO_REPO_ID, offset: 0, limit: 50, commits: commitList.filter(c => c.subject.toLowerCase().includes(query)), nextOffset: null });
    }
    if (/\/commits\/[a-f\d]{40}$/.test(path)) {
      const commit = commitList.find(c => c.oid === path.split('/').pop()) ?? commitList[0];
      return json({ repoId: DEMO_REPO_ID, ...commit, message: commit.subject, stats: { filesChanged: 1, insertions: 4, deletions: 3 }, files: [{ path: paths[0], additions: 4, deletions: 3 }] });
    }
    if (path.endsWith('/staging') || path.endsWith('/staging/hunks') || path.endsWith('/staging/patch')) {
      const selected = body.paths ?? [body.path ?? paths[0]];
      const unstage = String(body.action).startsWith('unstage') || body.scope === 'index';
      statusFiles = statusFiles.map(file => body.action?.endsWith('All') || selected.includes(file.path) ? { ...file, indexStatus: unstage ? '.' : 'M', worktreeStatus: unstage ? 'M' : '.', categories: [unstage ? 'unstaged' : 'staged'] } : file);
      const result = task('stage');
      queueMicrotask(() => emit('status.changed'));
      return json(result, 202);
    }
    if (path.endsWith('/commits') && method === 'POST') {
      if (!statusFiles.some(f => f.categories.includes('staged'))) return unsupported();
      const next = { ...commitList[0], oid: oid(commitList.length + 1), parents: [commitList[0].oid], subject: body.message, committedAtMs: timestamp + eventId };
      commitList.unshift(next); repository.head = next.oid; branches.branches[0].oid = next.oid;
      statusFiles = statusFiles.filter(file => !file.categories.includes('staged'));
      const result = task('commit');
      queueMicrotask(() => { emit('repository.updated'); emit('log.refsChanged'); });
      return json(result, 202);
    }
    return unsupported();
  };
  const bridge: GitCrestBridge = {
    getSidecarConnection: async () => ({ baseUrl: ORIGIN, token: 'in-memory-demo', windowAccess: 'readWrite' }),
    subscribeToEvents: async listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    chooseRepository: async () => repository.path,
    chooseCloneParent: async () => undefined,
    openDiffWindow: async () => {},
    openConflictWindow: async () => {},
    listLanguagePlugins: async () => ({ directory: '', plugins: [] }),
    openExternalUrl: async () => false,
  };
  Object.defineProperty(target, 'gitcrest', { configurable: true, value: bridge });
  // Do not expose native host window controls through the website, even when previewed in Electron.
  return { repository, bridge, fetch: target.fetch, storage };
}
