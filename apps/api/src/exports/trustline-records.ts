/**
 * What a full data export gives of Trustline's own log about the client
 * (docs/specs/data-export.md, decision 7): the action, its time, the staff
 * member's name, and of the details only what the client's own audit log
 * mirrors of the same change (security review 19, H1). Never Trustline's
 * note on the subscription, its AI spending limit, or its connection ids.
 * An action not listed here goes with no details at all: a new one is
 * worded here when it is added, or tells nothing of itself.
 */

type Details = Record<string, unknown> | null;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Only these keys of the details. */
const keys = (...allowed: string[]) => (d: Details) =>
  d ? Object.fromEntries(Object.entries(d).filter(([k]) => allowed.includes(k))) : null;

/** `{ changes }` with only these fields changed, each field maybe reduced. */
const changes =
  (allowed: Record<string, true | ((v: unknown) => unknown)>, prefix?: Record<string, (v: unknown) => unknown>) =>
  (d: Details) => {
    if (!d || !isObject(d.changes)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d.changes)) {
      const rule = allowed[k] ?? Object.entries(prefix ?? {}).find(([p]) => k.startsWith(p))?.[1];
      if (!rule) continue;
      out[k] = rule === true ? v : rule(v);
    }
    return { changes: out };
  };

/** A change `{ from, to }` of a feature's AI choice, as the client is told: the model only. */
const modelOnly = (change: unknown) => {
  if (!isObject(change)) return null;
  const reduce = (choice: unknown) => (isObject(choice) ? { model: choice.model ?? null } : null);
  return { from: reduce(change.from), to: reduce(change.to) };
};

export const TRUSTLINE_RECORD_DETAILS: Record<string, (d: Details) => unknown> = {
  client_created: keys('slug', 'plan'),
  // The client's settings, as `client_settings_changed_by_platform`.
  client_updated: changes({
    name: true,
    locales: true,
    accreditationStandard: true,
    defaultLocale: true,
    signInMethod: true,
    dataRegion: true,
    timeZone: true,
    status: true,
  }),
  client_administrator_created: keys('userId'),
  // As `subscription_changed`: never Trustline's note.
  subscription_updated: changes({
    planId: true,
    status: true,
    startsOn: true,
    renewsOn: true,
    trialEndsOn: true,
    addOnModules: true,
    limitOverrides: true,
  }),
  // As `ai_settings_changed`: never the spending limit nor a connection.
  ai_client_settings_updated: changes(
    { offered: true, allowanceOverrides: true, medicalOptionAllowed: true },
    { 'features.': modelOnly },
  ),
  import_window_set: keys('closesOn', 'reason'),
  contract_end_set: keys('from', 'to'),
  exit_window_set: keys('from', 'to'),
  retention_set: keys('from', 'to'),
  second_approval_recorded: keys('exportId', 'writtenRequest'),
  second_approval_request_recorded: keys('exportId', 'writtenRequest'),
  client_deletion_requested: keys('deletionId', 'reason', 'writtenInstruction'),
  client_deletion_approved: keys('deletionId'),
  client_deletion_cancelled: keys('deletionId'),
};

/** One of Trustline's records about the client, as the archive holds it. */
export function trustlineRecordOf(row: { action: string; at: string; staff: string | null; details: unknown }) {
  const shown = TRUSTLINE_RECORD_DETAILS[row.action];
  return { action: row.action, at: row.at, staff: row.staff, details: shown ? shown(isObject(row.details) ? row.details : null) : null };
}
