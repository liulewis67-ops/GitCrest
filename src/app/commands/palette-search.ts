import type { CommandPaletteCommand } from "./palette-commands";

/**
 * Other words people use for an action, matched in addition to its label and description. Git's
 * own names ("stash", "checkout") lead to the GitCrest feature that does the same job.
 */
export const COMMAND_SYNONYMS: Record<string, string> = {
  shelve: "stash park put aside shelf 搁置 暂存",
  "branch-switcher": "checkout switch change branch worktree 切换 检出",
  "checkout-commit": "detach detached head switch 检出 游离",
  "branch-here": "new branch create checkout 新建分支",
  "branch-at-head": "new branch create 新建分支",
  "reset-to-commit": "hard soft mixed move head 重置",
  reset: "hard soft mixed move head 重置",
  "create-tag": "release version label 标签",
  "cherry-pick": "copy commit pick 挑选",
  revert: "undo commit back out 还原 撤销",
  undo: "revert back 撤销",
  commit: "save record check in 提交",
  "commit-push": "ship publish 提交并推送",
  "stage-all": "add all git add 暂存",
  fetch: "download refresh remote 获取",
  pull: "update sync merge 拉取",
  push: "upload publish send 推送",
  "push-options": "tags follow-tags all tags review 推送 标签 选项",
  "pull-options": "rebase merge strategy review 拉取 变基 合并 策略 选项",
  refresh: "reload rescan status 刷新",
  "search-commits": "find log history grep 搜索 查找",
  "open-diff": "compare changes difference 差异",
  settings: "preferences options config 设置 偏好",
  theme: "dark light color 主题",
  appearance: "font density zoom 外观",
  init: "new repository git init 初始化",
  open: "folder repository 打开",
  clone: "download repository remote 克隆",
  "close-tab": "close repository 关闭",
  "new-worktree": "second checkout folder 工作树",
  "toggle-diff-view": "split unified side by side inline layout 并排 统一 分栏",
  "show-submodules": "submodule nested repository update init clone gitlink 子模块 嵌套 更新 初始化",
  "compare-refs": "compare diff branches tags between two refs 比较 对比 分支 差异",
  "compare-commit": "compare diff commit other branch tag 比较 对比 提交 差异",
  "compare-commit-tree": "compare diff commit working tree local changes 比较 对比 工作区 差异",
  "show-reflog": "lost commit recover undo reset history head moves lost deleted 找回 丢失 恢复",
  "open-in-editor": "code vscode ide edit source 编辑器",
  "open-in-terminal": "shell console command line bash powershell cmd 终端",
  "zoom-in": "bigger larger magnify text size 放大",
  "zoom-out": "smaller shrink text size 缩小",
  "zoom-reset": "default 100 percent actual size 重置缩放",
  "manage-remotes": "origin upstream url 远程",
};

const RECENT_KEY = "gitcrest.palette.recent";
export const RECENT_LIMIT = 5;

function normalize(text: string): string {
  return text.toLowerCase();
}

/** Every character of `needle` appears in `haystack` in order, such as "cpk" in "cherry-pick". */
function isSubsequence(needle: string, haystack: string): boolean {
  let position = 0;
  for (const character of haystack) {
    if (character === needle[position]) position += 1;
    if (position === needle.length) return true;
  }
  return needle.length === 0;
}

/** Higher is better; 0 means no match. */
export function scoreCommand(command: CommandPaletteCommand, query: string): number {
  const needle = normalize(query).trim();
  if (!needle) return 1;
  const label = normalize(command.label);
  const detail = normalize(command.detail);
  const synonyms = normalize(COMMAND_SYNONYMS[command.id] ?? "");
  const words = needle.split(/\s+/).filter(Boolean);
  if (label.startsWith(needle)) return 100;
  if (label.includes(needle)) return 80;
  // Every word of the query appears somewhere in the label, description or synonyms.
  const everything = `${label} ${detail} ${synonyms}`;
  if (words.every((word) => everything.includes(word))) {
    return words.every((word) => label.includes(word)) ? 70 : words.every((word) => `${label} ${synonyms}`.includes(word)) ? 60 : 50;
  }
  if (needle.length >= 2 && !needle.includes(" ") && isSubsequence(needle, label.replace(/[^\p{L}\p{N}]/gu, ""))) return 30;
  return 0;
}

/** The commands that match, best first; with no query the list keeps its order. */
export function rankCommands(commands: CommandPaletteCommand[], query: string): CommandPaletteCommand[] {
  if (!query.trim()) return commands;
  return commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score > 0)
    // A command that can run beats an equally good one that cannot.
    .sort((a, b) => b.score - a.score || Number(b.command.available) - Number(a.command.available) || a.index - b.index)
    .map((entry) => entry.command);
}

export function readRecentCommands(): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Puts `id` first, keeps the last few, and returns the new list. Storage failures only lose the history. */
export function rememberRecentCommand(id: string, current: readonly string[] = readRecentCommands()): string[] {
  const next = [id, ...current.filter((existing) => existing !== id)].slice(0, RECENT_LIMIT);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private windows or blocked storage: the palette still works without a history.
  }
  return next;
}

export function recentCommands(commands: CommandPaletteCommand[], recentIds: readonly string[]): CommandPaletteCommand[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return recentIds.flatMap((id) => {
    const command = byId.get(id);
    return command ? [command] : [];
  });
}
