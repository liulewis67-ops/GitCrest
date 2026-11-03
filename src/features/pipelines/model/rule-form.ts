import type { PipelineRule } from "../../../api/client";

export type PipelineRuleIssue =
  | { code: "command" }
  | { code: "name" }
  | { code: "pattern" }
  | { code: "noTargets" }
  | { code: "emptyTarget" }
  | { code: "duplicateTarget"; branch: string }
  | { code: "targetMatchesTrigger"; branch: string }
  | { code: "unknownPlaceholder"; name: string }
  | { code: "unbalancedTemplate" }
  | { code: "duplicateRuleId" };

export const DEFAULT_COMMIT_MESSAGE_TEMPLATE = "Merge branch '{source}' into {target}";
const PLACEHOLDERS = ["source", "target", "sourceShortOid"];
const PROTECTED_EXACT = ["main", "master"];
const PROTECTED_PREFIXES = ["release/", "prod"];

/** Same matching as the core: `*` and `?` stay inside one `/` segment, `**` crosses segments. */
export function globMatch(pattern: string, name: string): boolean {
  const go = (p: number, n: number): boolean => {
    if (p === pattern.length) return n === name.length;
    const c = pattern[p];
    if (c === "*") {
      if (pattern[p + 1] === "*") {
        for (let skip = n; skip <= name.length; skip += 1) if (go(p + 2, skip)) return true;
        return false;
      }
      for (let skip = n; skip <= name.length; skip += 1) {
        if (go(p + 1, skip)) return true;
        if (name[skip] === "/" || skip === name.length) break;
      }
      return false;
    }
    if (c === "?") return n < name.length && name[n] !== "/" && go(p + 1, n + 1);
    return n < name.length && name[n] === c && go(p + 1, n + 1);
  };
  return go(0, 0);
}

export function isProtectedTarget(branch: string): boolean {
  return PROTECTED_EXACT.includes(branch) || PROTECTED_PREFIXES.some((prefix) => branch.startsWith(prefix));
}

export function hasProtectedTarget(rule: Pick<PipelineRule, "targets">): boolean {
  return rule.targets.some((target) => isProtectedTarget(target.branch));
}

/** The confirmation the core will actually apply: protected-looking targets always ask. */
export function effectiveConfirmation(rule: Pick<PipelineRule, "targets" | "confirmation">): PipelineRule["confirmation"] {
  return hasProtectedTarget(rule) ? "ask" : rule.confirmation;
}

export function renderCommitMessage(template: string, source: string, target: string, sourceOid = "0123456789abcdef"): string {
  return template
    .split("{sourceShortOid}").join(sourceOid.slice(0, 7))
    .split("{source}").join(source)
    .split("{target}").join(target);
}

function templateIssue(template: string): PipelineRuleIssue | undefined {
  let index = 0;
  while (index < template.length) {
    const ch = template[index];
    if (ch === "}") return { code: "unbalancedTemplate" };
    if (ch === "{") {
      const close = template.slice(index + 1).search(/[{}]/);
      if (close < 0 || template[index + 1 + close] === "{") return { code: "unbalancedTemplate" };
      const name = template.slice(index + 1, index + 1 + close);
      if (!PLACEHOLDERS.includes(name)) return { code: "unknownPlaceholder", name };
      index += close + 2;
    } else {
      index += 1;
    }
  }
  return undefined;
}

/** The first problem the core would reject the rule for, so the form can say so before saving. */
export function validateRule(rule: PipelineRule, others: readonly PipelineRule[] = []): PipelineRuleIssue | undefined {
  if (!rule.name.trim()) return { code: "name" };
  if (!rule.trigger.branchPattern.trim()) return { code: "pattern" };
  if (rule.targets.length === 0 && !rule.commands?.length) return { code: "noTargets" };
  if ((rule.commands?.length ?? 0) > 50 || rule.commands?.some((command) => !command.program.trim() || command.program.includes("\0") || command.args.some((arg) => arg.includes("\0")) || !Number.isInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 3600)) return { code: "command" };
  const seen = new Set<string>();
  for (const target of rule.targets) {
    if (!target.branch.trim() || !target.remote.trim()) return { code: "emptyTarget" };
    const key = `${target.remote}\u0000${target.branch}`;
    if (seen.has(key)) return { code: "duplicateTarget", branch: target.branch };
    seen.add(key);
    if (globMatch(rule.trigger.branchPattern, target.branch)) return { code: "targetMatchesTrigger", branch: target.branch };
  }
  const template = templateIssue(rule.commitMessageTemplate);
  if (template) return template;
  if (others.some((other) => other.ruleId === rule.ruleId)) return { code: "duplicateRuleId" };
  return undefined;
}

export function newPipelineRule(ruleId: string): PipelineRule {
  return {
    ruleId,
    name: "",
    enabled: true,
    trigger: { kind: "afterPush", branchPattern: "feature/*" },
    targets: [],
    mergeMode: "noFastForward",
    commitMessageTemplate: DEFAULT_COMMIT_MESSAGE_TEMPLATE,
    pushAfterMerge: true,
    onConflict: "openResolver",
    afterConflictResolved: "continue",
    confirmation: "ask",
  };
}

/** A rule id that is unused in `rules`. */
export function nextRuleId(rules: readonly PipelineRule[]): string {
  const used = new Set(rules.map((rule) => rule.ruleId));
  for (let index = rules.length + 1; ; index += 1) {
    const id = `r_${String(index).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
}

/** Splits a remote-tracking ref (`refs/remotes/origin/uat`) into its remote and branch. */
export function splitRemoteBranch(fullName: string): { remote: string; branch: string } | undefined {
  const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(fullName);
  if (!match || match[2] === "HEAD") return undefined;
  return { remote: match[1], branch: match[2] };
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
