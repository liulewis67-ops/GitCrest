import type { DisplayError, ErrorDescription } from "../../../shared/i18n/api-errors";

const READ_FAILURES = new Set([
  "apiError.REPOSITORY_PATH_NOT_FOUND", "apiError.NOT_A_REPOSITORY", "apiError.REPOSITORY_ACCESS_DENIED",
  "apiError.REPOSITORY_STATUS_FAILED", "apiError.HISTORY_UNAVAILABLE",
]);

export function isRepositoryReadFailure(error: DisplayError | undefined): error is ErrorDescription {
  return Boolean(error && typeof error !== "string" && error.messageKey && READ_FAILURES.has(error.messageKey));
}
