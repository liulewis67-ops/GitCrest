const COMMIT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatCommitDate(timestamp: number): string {
  return COMMIT_DATE_FORMAT.format(new Date(timestamp));
}
