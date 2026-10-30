import { useSyncExternalStore } from "react";

export type NoticeKind = "success" | "warning" | "error";

export interface NoticeAction {
  label: string;
  /** Runs once; the notice goes away with it. */
  run: () => void;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  message: string;
  action?: NoticeAction;
}

export interface NoticeInput {
  kind: NoticeKind;
  message: string;
  action?: NoticeAction;
  /** A notice with the same key replaces the earlier one instead of stacking. */
  key?: string;
}

/** How long each kind stays; errors stay until dismissed, and a notice with an action stays longer. */
export const NOTICE_LIFETIME_MS = { success: 4000, warning: 8000, action: 10000 } as const;
export const MAX_NOTICES = 4;

const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const keys = new Map<number, string>();
let notices: readonly Notice[] = [];
let nextId = 1;

function emit(next: readonly Notice[]) {
  notices = next;
  for (const listener of listeners) listener();
}

function lifetime(input: NoticeInput): number | undefined {
  if (input.kind === "error") return undefined;
  return input.action ? NOTICE_LIFETIME_MS.action : NOTICE_LIFETIME_MS[input.kind];
}

export function dismissNotice(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  keys.delete(id);
  if (notices.some((notice) => notice.id === id)) emit(notices.filter((notice) => notice.id !== id));
}

/** Adds a notice and returns its id. Empty messages are ignored. */
export function pushNotice(input: NoticeInput): number | undefined {
  const message = input.message.trim();
  if (!message) return undefined;
  const replaced = input.key ? [...keys].find(([, key]) => key === input.key)?.[0] : undefined;
  if (replaced !== undefined) dismissNotice(replaced);
  const id = nextId++;
  const notice: Notice = { id, kind: input.kind, message, ...(input.action ? { action: input.action } : {}) };
  let next = [...notices, notice];
  // Past the limit the oldest notice that is not an error makes room; errors are never pushed out.
  while (next.length > MAX_NOTICES) {
    const victim = next.find((candidate) => candidate.kind !== "error" && candidate.id !== id);
    if (!victim) break;
    dismissNotice(victim.id);
    next = next.filter((candidate) => candidate.id !== victim.id);
  }
  if (input.key) keys.set(id, input.key);
  const duration = lifetime(input);
  if (duration !== undefined) timers.set(id, setTimeout(() => dismissNotice(id), duration));
  emit(next);
  return id;
}

export const notify = {
  success: (message: string, action?: NoticeAction) => pushNotice({ kind: "success", message, action }),
  warning: (message: string, action?: NoticeAction) => pushNotice({ kind: "warning", message, action }),
  error: (message: string, action?: NoticeAction) => pushNotice({ kind: "error", message, action }),
};

/** For tests: remove every notice and timer. */
export function clearNotices() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  keys.clear();
  emit([]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotices(): readonly Notice[] {
  return useSyncExternalStore(subscribe, () => notices, () => notices);
}
