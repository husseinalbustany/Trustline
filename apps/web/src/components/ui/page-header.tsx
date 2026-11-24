import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold ltr:tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex max-w-full shrink-0 flex-wrap gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
