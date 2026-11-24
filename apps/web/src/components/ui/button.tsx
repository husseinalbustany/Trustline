import type { ButtonHTMLAttributes } from "react";

const styles = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "border border-line text-foreground hover:bg-surface",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof styles;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap disabled:opacity-60 ${styles[variant]} ${className}`}
    />
  );
}
