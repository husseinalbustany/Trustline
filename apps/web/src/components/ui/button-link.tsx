import Link from "next/link";
import type { ReactNode } from "react";

export function ButtonLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium whitespace-nowrap text-accent-fg hover:bg-accent-hover"
    >
      {children}
    </Link>
  );
}
