import type { ReactNode } from "react";

export function Panel({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-background">
      {title && (
        <h2 className="border-b border-line px-4 py-3 text-sm font-medium">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-10 text-center text-sm text-muted">{children}</p>
  );
}
