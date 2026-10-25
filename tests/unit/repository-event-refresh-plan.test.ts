import { expect, it } from "vitest";
import type { GitCrestEventEnvelope } from "../../src/api/bridge";
import { getRepositoryEventRefreshPlan } from "../../src/features/repositories/model/repository-event-refresh-plan";

function event(type: string): GitCrestEventEnvelope {
  return { eventId: "1", protocolVersion: 1, type, occurredAtMs: 1, payload: {} } as GitCrestEventEnvelope;
}

it("leaves repositories alone for account events but refreshes for unknown ones", () => {
  const open = () => true;
  expect(getRepositoryEventRefreshPlan(event("accounts.changed"), false, "repo_a", open)).toBeUndefined();
  expect(getRepositoryEventRefreshPlan(event("accounts.deviceFlow.updated"), false, "repo_a", open)).toBeUndefined();
  expect(getRepositoryEventRefreshPlan(event("something.new"), false, "repo_a", open)?.refreshRepositories).toBe(true);
});
