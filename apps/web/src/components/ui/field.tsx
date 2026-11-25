import type { ReactNode } from "react";

export const inputClass =
  "h-10 w-full rounded-md border border-line bg-background px-3 text-sm font-normal";

/**
 * The same control on the pages built for a phone first: tall enough for a
 * thumb, and in a text size a phone does not zoom into when it is tapped.
 */
export const roomyInputClass =
  "h-12 w-full rounded-md border border-line bg-background px-3 text-base font-normal";

/**
 * A labelled form control. The control sits inside the label, so no ids are
 * needed: Next.js keeps visited pages mounted but hidden, and ids repeated
 * across them would attach a label to the wrong page's control.
 */
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      {children}
      {help && <span className="text-xs font-normal text-muted">{help}</span>}
    </label>
  );
}
