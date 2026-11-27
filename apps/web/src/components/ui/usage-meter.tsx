import { fill, numberFormat } from "@/lib/format";

export type UsageMeterText = {
  /** "{used} of {max} in use" */
  usedOf: string;
  /** "{used} in use" */
  inUse: string;
  unlimited: string;
  atLimit: string;
};

/**
 * How much of a limit is used: the figures in words, and a bar for the eye.
 * With no limit there is no bar, only the count and "Unlimited".
 */
export function UsageMeter({
  lang,
  label,
  help,
  used,
  max,
  t,
}: {
  lang: string;
  label: string;
  help?: string;
  used: number;
  /** Null: no limit. */
  max: number | null;
  t: UsageMeterText;
}) {
  const numbers = numberFormat(lang);
  const reached = max !== null && used >= max;
  const share =
    max === null ? 0 : max === 0 ? 100 : Math.min(100, (used / max) * 100);

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">
          {max === null
            ? `${fill(t.inUse, { used: numbers.format(used) })} · ${t.unlimited}`
            : fill(t.usedOf, {
                used: numbers.format(used),
                max: numbers.format(max),
              })}
        </span>
      </div>
      {max !== null && (
        <div
          aria-hidden
          className="h-2 overflow-hidden rounded-full border border-line bg-surface"
        >
          <div
            className={`h-full rounded-full ${reached ? "bg-warn" : "bg-accent"}`}
            style={{ width: `${share}%` }}
          />
        </div>
      )}
      {reached && <p className="text-xs font-medium text-warn">{t.atLimit}</p>}
      {help && <p className="text-xs text-muted">{help}</p>}
    </div>
  );
}
