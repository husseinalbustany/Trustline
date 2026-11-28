import { pickText, type Locale, type Localized } from '../i18n/locales.js';
import { AUDIT_ACTIONS, type AuditAction } from './actions.js';
import type { AuditWording } from './wording/types.js';

/**
 * An entry's details as sentences, in one language, for the viewer
 * (`detailLines`) and the CSV alike (language review 10): the field first,
 * then its value; a change as "from … to …" in the language's own words;
 * ids as the names, references and numbers they stand for; codes as words.
 * Some actions read as one whole sentence (`templates`).
 */
export type DetailContext = {
  words: AuditWording;
  locale: Locale;
  defaultLocale: string;
  /** What an id stands for: a name to pick, or a reference or number. */
  names: Map<string, string | Localized>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALES = new Set(['en', 'ar', 'fr']);

/** The keys whose values are codes, worded from `details.values`. */
const CODED = new Set([
  'status', 'reason', 'secondFactor', 'by', 'client', 'purpose', 'action', 'channel',
  'visibility', 'outcome', 'via', 'type', 'harmLevel', 'kind', 'to', 'from',
  // How a document came into Trustline, and who wrote a draft's version.
  'source', 'author',
]);

/** The screen a route is, for what an external reviewer viewed. */
export function screenOf(route: string): keyof AuditWording['details']['screens'] {
  if (/\/incidents\/:id(\/|$)/.test(route)) return 'incident';
  if (/\/incidents(\/|$)/.test(route)) return 'incidents';
  if (/\/policies\/documents\/:id(\/|$)/.test(route)) return 'document';
  if (/\/policies(\/|$)/.test(route)) return 'documents';
  if (/\/audit\/(exports|checkpoints)(\/|$)/.test(route)) return 'auditDownload';
  if (/\/audit(\/|$)/.test(route)) return 'audit';
  if (/\/reports(\/|$)/.test(route)) return 'reports';
  if (/\/users(\/|$)/.test(route)) return 'users';
  if (/\/dashboard(\/|$)/.test(route)) return 'dashboard';
  return 'other';
}

const isLocalized = (v: object): v is Localized =>
  Object.keys(v).length > 0 && Object.entries(v).every(([k, x]) => LOCALES.has(k) && typeof x === 'string');

/** Every id the details name, for looking their names up at once. */
export function idsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string' && UUID.test(value)) into.add(value);
  else if (Array.isArray(value)) for (const v of value) idsIn(v, into);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) idsIn(v, into);
  return into;
}

export function detailLines(action: AuditAction, details: Record<string, unknown> | null, ctx: DetailContext): string[] {
  if (!details) return [];
  const { words } = ctx;
  const d = words.details;
  const legacy = new Set<string>((AUDIT_ACTIONS[action] as { legacy?: readonly string[] }).legacy ?? []);
  const pick = (v: string | Localized) => (typeof v === 'string' ? v : pickText(v, ctx.locale, ctx.defaultLocale));
  const label = (key: string) => (d.fields as Record<string, string>)[key] ?? key;
  const fmt = (key: string, v: unknown): string => {
    if (v === null || v === undefined || v === '') return d.none;
    if (typeof v === 'boolean') return v ? d.yes : d.no;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') {
      if (UUID.test(v)) {
        const name = ctx.names.get(v);
        return name ? pick(name) : v.slice(0, 8);
      }
      if (CODED.has(key) && Object.hasOwn(d.values, v)) return d.values[v];
      return v;
    }
    if (Array.isArray(v)) return v.length === 0 ? d.none : v.map((x) => fmt(key, x)).join(', ');
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (isLocalized(o)) return pick(o);
      if ('from' in o || 'to' in o) {
        return d.change.replace('{from}', fmt(key, o.from)).replace('{to}', fmt(key, o.to));
      }
      const parts = Object.entries(o).map(([k, x]) => `${label(k)}${d.colon}${fmt(k, x)}`);
      return parts.length === 0 ? d.none : parts.join('; ');
    }
    return JSON.stringify(v);
  };
  const fill = (template: string, values: Record<string, string>) =>
    template.replace(/\{([A-Za-z]+)\}/g, (_, k: string) => values[k] ?? d.none).replace(/\s+$/, '');

  if (action === 'external_reviewer_viewed') {
    const route = typeof details.route === 'string' ? details.route : '';
    const record = typeof details.recordId === 'string' ? fmt('recordId', details.recordId) : '';
    return [fill(d.templates[action], { screen: d.screens[screenOf(route)], record })];
  }
  const template =
    (typeof details.by === 'string' ? d.templates[`${action}.${details.by}`] : undefined) ?? d.templates[action];
  if (template) {
    const values: Record<string, string> = {};
    for (const key of template.match(/\{([A-Za-z]+)\}/g) ?? []) {
      const k = key.slice(1, -1);
      const v = details[k];
      values[k] = v === null || v === undefined ? (k === 'from' || k === 'to' ? d.all : d.none) : fmt(k, v);
    }
    return [fill(template, values)];
  }
  const order = AUDIT_ACTIONS[action].details as readonly string[];
  const keys = Object.keys(details)
    .filter((k) => !legacy.has(k))
    .sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  return keys.map((k) => `${label(k)}${d.colon}${fmt(k, details[k])}`);
}
