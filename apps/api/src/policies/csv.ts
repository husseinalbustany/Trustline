/**
 * Comma-separated files for the evidence a client takes out of Trustline
 * (the master list of documents, who acknowledged a version), written to
 * open as they are in a spreadsheet:
 *
 * - UTF-8 with a byte-order mark, which is how Excel knows the file is
 *   UTF-8, so that Arabic and accented French come out as written;
 * - every cell quoted, a quote inside doubled, lines ended CRLF (RFC 4180);
 * - no cell that a spreadsheet would run as a formula (CSV injection): one
 *   that starts with `=`, `+`, `-`, `@` (or their full-width forms), a tab
 *   or a carriage return, after any spaces, is given a leading apostrophe,
 *   which spreadsheets show as text and do not run. Every cell is
 *   neutralised, whoever wrote it, since a title or a person's name is
 *   written by someone other than whoever opens the file.
 */

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

const BOM = '﻿';

// eslint-disable-next-line no-control-regex
const FORMULA_START = /^[\s\u00a0]*[=+\-@\uff1d\uff0b\uff0d\uff20\t\r]/;

export type Cell = string | number | boolean | null | undefined;

/** One cell as written in the file. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** The whole file: its headings, then one line per row. */
export function csv(headings: string[], rows: Cell[][]): string {
  const lines = [headings, ...rows].map((row) => row.map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/**
 * A file name for an export: what it is and the client's day, in letters,
 * digits and hyphens only, so that it is the same in every browser.
 */
export function csvFileName(what: string, day: string) {
  return `${what.replace(/[^A-Za-z0-9-]/g, '-')}-${day}.csv`;
}
