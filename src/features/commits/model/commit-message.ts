const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

export function composeCommitMessage(summary: string, description: string): string {
  const subject = summary.trim();
  const body = description.replace(LEADING_BLANK_LINES, "").trimEnd();
  return body ? `${subject}\n\n${body}` : subject;
}

export function splitCommitMessage(message: string): { summary: string; description: string } {
  const [summary = "", ...rest] = message.replace(/\r\n/g, "\n").trimStart().split("\n");
  return { summary: summary.trim(), description: rest.join("\n").replace(LEADING_BLANK_LINES, "").trimEnd() };
}
