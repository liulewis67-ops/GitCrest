import type { ReactNode } from "react";

/** What to show when a list has nothing yet: one sentence, and the next step as a button when there is one. */
export function EmptyState({ children, actionLabel, onAction, actionDisabled = false, actionTitle }: {
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  /** Why the action is unavailable now. */
  actionTitle?: string;
}) {
  return <div className="emptyState">
    <p>{children}</p>
    {actionLabel && onAction && <button className="secondaryButton compact" type="button" disabled={actionDisabled} title={actionTitle} onClick={onAction}>{actionLabel}</button>}
  </div>;
}
