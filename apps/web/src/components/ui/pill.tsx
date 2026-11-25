import type { ReactNode } from "react";

const tones = {
  ok: "bg-accent-soft text-accent",
  danger: "bg-danger-soft text-danger",
  // Solid, for what must not be missed. Both colours are tokens, so it
  // keeps its contrast in dark mode.
  alert: "bg-danger text-background",
  neutral: "bg-surface text-muted",
};

export function Pill({
  tone,
  icon,
  children,
}: {
  tone: keyof typeof tones;
  /** Shown in place of the dot. Decoration only: the words say it. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {icon ?? <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
