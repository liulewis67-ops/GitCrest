import { t, type MessageKey } from "./index";
import { apiErrorMessages } from "./messages/api-errors";

export type ErrorDescription = { message: string; details?: string; messageKey?: MessageKey };
export type DisplayError = string | ErrorDescription;

/** User-authored validation text stays a string; API failures retain separate diagnostic text. */
export function describeApiError(error: unknown, fallback?: string): ErrorDescription {
  if (error && typeof error === "object" && "body" in error) {
    const body = error.body;
    if (body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object") {
      const failure = body.error;
      if ("code" in failure && typeof failure.code === "string" && "message" in failure && typeof failure.message === "string") {
        const candidate = `apiError.${failure.code}`;
        const messageKey = Object.prototype.hasOwnProperty.call(apiErrorMessages, candidate)
          ? candidate as keyof typeof apiErrorMessages : "apiError.unknown";
        return { message: t(messageKey), messageKey, details: `${failure.code}\n${failure.message}` };
      }
    }
  }
  return {
    message: fallback || t("apiError.unknown"),
    ...(!fallback ? { messageKey: "apiError.unknown" as const } : {}),
    ...(error instanceof Error && error.message ? { details: error.message } : {}),
  };
}

/** For tooltips and OS notifications, which can only contain text. */
export function errorText(error: DisplayError): string {
  return typeof error === "string" ? error : error.messageKey ? t(error.messageKey) : error.message;
}
