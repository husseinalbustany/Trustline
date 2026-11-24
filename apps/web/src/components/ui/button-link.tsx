import Link from "next/link";
import type { ReactNode } from "react";

const styles = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "border border-line text-foreground hover:bg-surface",
};

export function ButtonLink({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: keyof typeof styles;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap ${styles[variant]}`}
    >
      {children}
    </Link>
  );
}
