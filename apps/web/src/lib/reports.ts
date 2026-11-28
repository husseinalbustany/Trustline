import type { Localized } from "./localized";

export type Direction = "below" | "at_least" | "above" | (string & {});
export type ValueUnit = "seconds" | "percent" | "count" | (string & {});
export type TargetSource = "business" | "client" | "baseline" | "first_months" | (string & {});

/** What explains a figure, by measure. Only what the API sends is shown. */
export type MeasureDetails = {
  quickShare?: number | null;
  withStartTime?: number;
  reported?: number;
  pending?: number;
  nearMissShare?: number | null;
  /** Only for those told how reports arrived. */
  channel?: { public: number; anonymous: number; named: number };
  [key: string]: unknown;
};

/** One month of a measure, at its latest revision. */
export type MeasureMonth = {
  month: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  target: number | null;
  targetSource: TargetSource | null;
  met: boolean | null;
  status: "provisional" | "final" | (string & {});
  method: "snapshot" | "reconstructed" | "corrected" | (string & {});
  revision: number;
  correctedAt: string | null;
  asAt: string;
  takenAt: string;
  definitionVersion: number;
  details: MeasureDetails | null;
};

export type Measure = {
  code: string;
  module: string;
  direction: Direction;
  valueUnit: ValueUnit;
  definitionVersion: number;
  /** In force now. */
  target: number | null;
  targetSource: TargetSource | null;
  /** Only the months that were taken; none is filled in. */
  months: MeasureMonth[];
  /** The month so far, worked out when read. */
  current: {
    month: string;
    value: number | null;
    numerator: number | null;
    denominator: number | null;
    met: boolean | null;
    provisional: boolean;
    asOf: string;
    details: MeasureDetails | null;
  } | null;
};

export type MeasureSeries = { unitId: string | null; measures: Measure[] };

export type Revision = {
  revision: number;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  target: number | null;
  met: boolean | null;
  status: string;
  method: string;
  reason: string | null;
  requestedBy: { id: string; name: Localized | null } | null;
  asAt: string;
  takenAt: string;
  definitionVersion: number;
  details: MeasureDetails | null;
};

export type MeasureHistory = { code: string; month: string; unitId: string | null; revisions: Revision[] };

export type ReportSettings = {
  revision: number;
  targets: {
    code: string;
    module: string;
    direction: Direction;
    business: number | null;
    client: number | null;
    effective: number | null;
  }[];
  baseline: { monthlyAverage: number; note: Localized } | null;
  firstMonthsBaseline: number | null;
  reportedTarget: { value: number | null; source: TargetSource | null };
};

/** "2026-11" moved by some months. */
export function addMonths(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** The month a day falls in, on the organization's calendar. */
export const monthOf = (day: string) => day.slice(0, 7);

/** The periods offered, in months back from this one. */
export const periods = [6, 12, 24] as const;
export const defaultPeriod = 12;
