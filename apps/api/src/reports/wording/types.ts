import type { Breakdown, CHANNELS, HARM_LEVELS, INCIDENT_TYPES } from '../breakdowns.js';
import type { MeasureCode } from '../measures.js';

/**
 * What the API writes of reports, in one language: the CSV of the measures and of the incident breakdowns
 * (docs/specs/reports-and-measures.md, "Languages"). Every language has
 * exactly these keys (wording.spec.ts). The screens' words are the web
 * app's.
 */
export type ReportsWording = {
  measures: Record<MeasureCode, string>;
  csv: {
    month: string;
    unit: string;
    unitPath: string;
    measure: string;
    value: string;
    numerator: string;
    denominator: string;
    target: string;
    met: string;
    status: string;
    method: string;
    revision: string;
    asAt: string;
    definitionVersion: string;
    // The incident breakdowns' file (step 5).
    from: string;
    to: string;
    typeFilter: string;
    harmFilter: string;
    count: string;
    share: string;
    runningShare: string;
    partial: string;
    /** The unit's own row, beside those beneath it: `{unit}`. */
    here: string;
  };
  /** The heading of the breakdown's column. */
  by: Record<Breakdown, string>;
  types: Record<(typeof INCIDENT_TYPES)[number], string>;
  harm: Record<(typeof HARM_LEVELS)[number], string>;
  channels: Record<(typeof CHANNELS)[number], string>;
  /** A filter not set. */
  all: string;
  organization: string;
  status: { provisional: string; final: string };
  method: { snapshot: string; reconstructed: string; corrected: string };
  yes: string;
  no: string;
};
