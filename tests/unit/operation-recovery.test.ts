import { describe, expect, it } from "vitest";
import type { OperationRecoveryResponse } from "../../src/api/client";
import { availableRecoveryActions, buildActionSubmission, recoveryActionGroup } from "../../src/features/operations/model/operation-recovery";

const operation = (patch: Partial<OperationRecoveryResponse>) => ({
  operationId: "op", version: "9007199254740993", actionsEnabled: true,
  allowedActions: ["continuePullRebase", "abortPullRebase", "reconcilePullRebaseConflict"], ...patch,
}) as OperationRecoveryResponse;

describe("operation recovery model", () => {
  it("groups action kinds", () => {
    expect(recoveryActionGroup("continuePullMerge")).toBe("continue");
    expect(recoveryActionGroup("abortPullRebase")).toBe("abort");
    expect(recoveryActionGroup("reconcileSave")).toBe("reconcile");
    expect(recoveryActionGroup("resumeSaving")).toBe("resume");
    expect(recoveryActionGroup("preparePull")).toBe("other");
  });
  it("offers nothing when the server disables actions", () => {
    expect(availableRecoveryActions(operation({ actionsEnabled: false }))).toEqual([]);
  });
  it("builds a submission with the exact string version and rejects disallowed kinds", () => {
    expect(buildActionSubmission(operation({}), "abortPullRebase", "r1")).toEqual({
      requestId: "r1", kind: "abortPullRebase", expectedVersion: "9007199254740993",
    });
    expect(() => buildActionSubmission(operation({}), "restoreNext", "r2")).toThrow(/not currently allowed/);
  });
});
