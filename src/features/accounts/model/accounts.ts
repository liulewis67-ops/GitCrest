import type { AccountResponse, HostingProvider } from "../../../api/client";

export const DEFAULT_HOSTS: Record<HostingProvider, string> = { github: "github.com", gitlab: "gitlab.com" };

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 7;

export interface AccountHostGroup {
  host: string;
  accounts: AccountResponse[];
}

/** Hosts in name order, the account Git uses for each host first. */
export function groupAccountsByHost(accounts: readonly AccountResponse[]): AccountHostGroup[] {
  const groups = new Map<string, AccountResponse[]>();
  for (const account of accounts) groups.set(account.host, [...(groups.get(account.host) ?? []), account]);
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([host, hostAccounts]) => ({
      host,
      accounts: [...hostAccounts].sort((left, right) => Number(right.selected) - Number(left.selected)),
    }));
}

/** The provider page that creates a personal access token with the scopes GitCrest needs. */
export function tokenCreationUrl(provider: HostingProvider, host: string): string | undefined {
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) || host.startsWith(".") || host.endsWith(".")) return undefined;
  const origin = `https://${host.toLowerCase()}`;
  if (provider === "github") {
    return `${origin}/settings/tokens/new?${new URLSearchParams({ description: "GitCrest", scopes: "repo,read:user" })}`;
  }
  return `${origin}/-/user_settings/personal_access_tokens?${new URLSearchParams({ name: "GitCrest", scopes: "read_user,read_repository,write_repository" })}`;
}

export type TokenExpiry = { kind: "expired" } | { kind: "today" } | { kind: "soon"; days: number };

/** Only an expired token or one that expires within a week needs attention. */
export function tokenExpiry(expiresAtMs: number | null, nowMs: number): TokenExpiry | undefined {
  if (expiresAtMs === null) return undefined;
  if (expiresAtMs <= nowMs) return { kind: "expired" };
  const days = Math.floor((expiresAtMs - nowMs) / DAY_MS);
  if (days === 0) return { kind: "today" };
  if (days <= EXPIRY_WARNING_DAYS) return { kind: "soon", days };
  return undefined;
}
