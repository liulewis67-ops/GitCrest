import { t } from "../../../shared/i18n";
import { notify } from "../../../shared/notices/notice-store";

let announced = false;

/**
 * Tells the user, once per session, that protected operations are switched on but this core cannot run them (its
 * creation flag is off, or it is too old), so the usual flow was used. Without it the fallback would be silent and the
 * user would believe their changes were protected by an operation when they were not.
 */
export function announceOperationsUnavailable() {
  if (announced) return;
  announced = true;
  notify.warning(t("op.unavailable"));
}

/** For tests: forget that the notice was already shown. */
export function resetOperationsUnavailableNotice() {
  announced = false;
}
