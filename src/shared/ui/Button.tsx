import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "regular" | "compact";
};

/** Shared action control. Destructive final actions always use the danger variant. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "regular", className = "", type = "button", ...props }, ref) {
  return <button {...props} ref={ref} type={type} className={`gcButton gcButton-${variant} gcButton-${size} ${className}`.trim()} />;
});
