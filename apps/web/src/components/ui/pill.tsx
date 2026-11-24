import type { ReactNode } from "react";

const tones = {
  ok: "bg-accent-soft text-accent",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-surface text-muted",
};

export function Pill({
  tone,
  children,
}: {
  tone: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}
