import type { MeasureCode } from '../measures.js';

/**
 * What the API writes of reports, in one language: the CSV of the measures
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
  };
  organization: string;
  status: { provisional: string; final: string };
  method: { snapshot: string; reconstructed: string; corrected: string };
  yes: string;
  no: string;
};
