"use client";

import { useState } from "react";

export type Point = {
  /** "2026-11": every month of the period, taken or not. */
  month: string;
  value: number | null;
  met: boolean | null;
  /** Said on hover and focus, and to screen readers. */
  text: string;
};

/**
 * A month-by-month line with its target, drawn small and plain: no
 * library, nothing loaded from elsewhere. Time runs from the inline start,
 * so right to left in Arabic. The line is drawn in SVG; each month's point
 * is a button over it, placed with logical offsets, so it mirrors with the
 * page, can be reached by keyboard, and says its figure on hover and focus.
 * Colour is used only for met and not met, and never alone: the figures
 * table beside it says the same in words.
 */
export function TrendChart({
  label,
  points,
  target,
  targetLabel,
  ceiling,
  format,
  firstMonth,
  lastMonth,
}: {
  label: string;
  points: Point[];
  target: number | null;
  targetLabel: string;
  /** The top of the scale when it is fixed (100 for a share). */
  ceiling?: number;
  /** A value on the scale, in the measure's own terms. */
  format: (value: number) => string;
  /** The period's first and last months, said under the line. */
  firstMonth: string;
  lastMonth: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const top = ceiling ?? Math.max(1, ...values, target ?? 0) * 1.15;
  const x = (i: number) => (points.length <= 1 ? 50 : 4 + (92 * i) / (points.length - 1));
  const y = (v: number) => 94 - (88 * Math.min(v, top)) / top;

  // The line, broken where a month was not taken.
  const runs: string[] = [];
  let run: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) runs.push(run.join(" "));
      run = [];
    } else run.push(`${x(i)},${y(p.value)}`);
  });
  if (run.length) runs.push(run.join(" "));

  const shown = active ?? [...points].reverse().findIndex((p) => p.value !== null);
  const caption =
    active !== null
      ? points[active]?.text
      : shown >= 0
        ? points[points.length - 1 - shown]?.text
        : null;

  return (
    <figure className="flex flex-col gap-2">
      <div role="group" aria-label={label} className="relative h-36 sm:h-44">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
          className="absolute inset-0 h-full w-full overflow-visible rtl:-scale-x-100"
        >
          <line x1="0" y1="94" x2="100" y2="94" className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {target !== null && (
            <line
              x1="0"
              y1={y(target)}
              x2="100"
              y2={y(target)}
              className="stroke-muted"
              strokeWidth="1.5"
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {runs.map((r, i) => (
            <polyline
              key={i}
              points={r}
              fill="none"
              className="stroke-foreground"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {/* The scale: its top and its bottom, at the inline start. */}
        <span className="absolute start-0 top-0 text-xs text-muted tabular-nums" aria-hidden>
          {format(Math.round(top))}
        </span>
        <span className="absolute start-0 bottom-[6%] text-xs text-muted tabular-nums" aria-hidden>
          {format(0)}
        </span>
        {target !== null && (
          <span
            className="absolute end-0 -translate-y-full bg-background/80 px-1 text-xs text-muted"
            style={{ top: `${y(target)}%` }}
            aria-hidden
          >
            {targetLabel}
          </span>
        )}
        {points.map((p, i) =>
          p.value === null ? null : (
            <button
              key={p.month}
              type="button"
              aria-label={p.text}
              title={p.text}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className={`absolute size-3 -translate-y-1/2 rounded-full border-2 border-background outline-offset-2 rtl:translate-x-1/2 ltr:-translate-x-1/2 ${
                p.met === true ? "bg-accent" : p.met === false ? "bg-danger" : "bg-muted"
              } ${active === i ? "ring-2 ring-foreground" : ""}`}
              style={{ insetInlineStart: `${x(i)}%`, top: `${y(p.value)}%` }}
            />
          ),
        )}
      </div>
      <div className="flex justify-between text-xs text-muted" aria-hidden>
        <span>{firstMonth}</span>
        <span>{lastMonth}</span>
      </div>
      <figcaption aria-live="polite" className="min-h-5 text-sm text-muted">
        {caption}
      </figcaption>
    </figure>
  );
}
