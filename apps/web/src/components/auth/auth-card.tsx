import type { ReactNode } from "react";

export function AuthCard({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="flex flex-1 items-center justify-center bg-surface px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-lg border border-line bg-background p-6">
        <div>
          <p className="text-sm font-medium text-accent">{eyebrow}</p>
          <h1 className="mt-1 text-xl font-semibold ltr:tracking-tight">
            {title}
          </h1>
        </div>
        {children}
      </div>
    </main>
  );
}
