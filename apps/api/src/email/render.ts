import type { Locale } from '../i18n/locales.js';
import type { DataExportChange, ImmediateKind } from './kinds.js';
import type { EmailSwitch } from './unsubscribe-token.js';
import { fill, WORDING, type Wording } from './wording/index.js';

/** One reference in a digest, with the link to it. */
export type DigestItem = { label: string; href: string; overdue?: boolean };

export type DigestSectionKey =
  | 'acknowledge'
  | 'approve'
  | 'stepsOverdue'
  | 'reviews'
  | 'incidents'
  | 'riskReviews'
  | 'actionsDue'
  | 'riskProposals'
  | 'riskSteps';

export type DigestSection = {
  key: DigestSectionKey;
  count: number;
  /** For incidents and actions: how many of them are overdue. */
  overdueCount?: number;
  /** The first few, in the order the screen shows them. */
  items: DigestItem[];
};

/**
 * What an email is about: short values only, the same an in-app
 * notification carries (a reference, a number, a version, a count). There
 * is no field here for a description, a comment, a title or a name, so none
 * can reach an email.
 */
export type MailContent =
  | {
      category: 'immediate';
      kind: ImmediateKind;
      /** An incident's reference. */
      reference?: string;
      /** What was done to a signing PIN: set, changed, reset. */
      action?: 'set' | 'changed' | 'reset';
      /** A document's number, version and step. */
      number?: string;
      version?: number;
      step?: 'review' | 'approve';
      /** What happened to a full data export (data_export_changed). */
      change?: DataExportChange;
      /** The audit chain's head (audit_chain_head): its number, seal and day. */
      count?: number;
      hash?: string;
      day?: string;
      href: string;
    }
  | {
      /** An external reviewer's one-time sign-in code. Nothing else. */
      category: 'sign_in_code';
      code: string;
      minutes: number;
    }
  | {
      category: 'weekly_digest';
      topic: 'risks';
      /** Reviews and actions overdue in the reach of the manager. */
      reviewsOverdue: number;
      actionsOverdue: number;
      /** Acceptance and closure steps overdue: for whole-organization managers. */
      stepsOverdue: number;
      href: string;
    }
  | {
      category: 'weekly_digest';
      topic?: 'acknowledgements';
      overdue: number;
      people: number;
      /** Approval steps overdue on documents they manage (quality review 3, S2). */
      stepsOverdue: number;
      href: string;
    }
  | {
      category: 'daily_digest';
      day: string;
      sections: DigestSection[];
      href: string;
    };

/** Who an email is to, as the wording needs it. */
export type MailEnvelope = {
  locale: Locale;
  /** The organization's name in the recipient's language. */
  organization: string;
  /** None for a sign-in code, which nobody can switch off or ask for. */
  unsubscribe: { href: string; switch: EmailSwitch } | null;
  preferencesHref: string | null;
};

export type RenderedMail = { subject: string; text: string; html: string };

/** The most references a digest section lists; the rest are counted. */
export const DIGEST_ITEMS = 10;

// Unicode isolates: a reference such as INC-2026-00042 keeps its order in
// right-to-left text.
const LRI = '\u2066';
const PDI = '\u2069';
// A first-strong isolate: a date written as the language writes it keeps
// that direction, set apart from the text around it.
const FSI = '\u2068';

/**
 * A calendar day ("2026-11-28") as the web app shows it in this language
 * (language review 7, E16): medium style, Latin digits. The day is already
 * the organization's (worked out on its clock when the digest was made), so
 * it is shown as it is, on no clock.
 */
export function formatDay(day: string, locale: Locale): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(
    new Intl.Locale(locale, { numberingSystem: 'latn' }).toString(),
    { dateStyle: 'medium', timeZone: 'UTC' },
  ).format(date);
}

/** Text for HTML, escaped for an element or an attribute. */
export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** One line: no control character or line break survives into a header. */
// eslint-disable-next-line no-control-regex
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

type Paragraph =
  | { kind: 'text'; text: string }
  /** A value to copy as it is: left to right, monospace, wrapped anywhere. */
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'list'; items: DigestItem[] };

/**
 * The email for this content, in the recipient's language: a subject, a
 * plain text body and a simple HTML body (no image, no external resource,
 * no script; the only links lead to Trustline).
 */
export function renderMail(content: MailContent, envelope: MailEnvelope): RenderedMail {
  const w = WORDING[envelope.locale];
  const rtl = w.dir === 'rtl';
  // A value put into a sentence: isolated in right-to-left text, so that a
  // reference reads as it is written.
  const value = (v: string | number) => (rtl ? `${LRI}${v}${PDI}` : String(v));
  const say = (text: string, values: Record<string, string | number> = {}) =>
    fill(
      text,
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, value(v)])),
    );

  let subject: string;
  const body: Paragraph[] = [{ kind: 'text', text: w.greeting }];

  if (content.category === 'immediate') {
    const key =
      content.kind === 'document_step_assigned'
        ? content.step === 'approve'
          ? 'document_step_approve'
          : 'document_step_review'
        : content.kind === 'signing_pin_changed'
          ? (`signing_pin_${content.action ?? 'changed'}` as const)
          : content.kind === 'data_export_changed'
            ? (`data_export_${content.change ?? 'requested'}` as const)
            : content.kind;
    if (content.kind === 'audit_chain_head') {
      // The seal in a paragraph of its own, to be copied whole (language
      // review 10), and the day it was checked, as the digest shows days.
      const t = w.immediate.audit_chain_head;
      const day = formatDay(content.day ?? '', envelope.locale);
      subject = t.subject;
      body.push({
        kind: 'text',
        text: fill(t.body, { day: rtl ? `${FSI}${day}${PDI}` : day, count: value(content.count ?? '') }),
      });
      body.push({ kind: 'code', text: content.hash ?? '' });
      body.push({ kind: 'text', text: t.keep });
      body.push({ kind: 'link', text: w.open, href: content.href });
      return finish(subject, body, [
        { kind: 'text', text: say(w.footer.member, { organization: oneLine(envelope.organization) }) },
        // Not to be switched off: said, instead of a link that would not.
        { kind: 'text', text: w.footer.alwaysAuditSeal },
        ...(envelope.preferencesHref ? [{ kind: 'link' as const, text: w.footer.preferences, href: envelope.preferencesHref }] : []),
      ]);
    }
    const text = w.immediate[key as Exclude<typeof key, 'audit_chain_head'>];
    const values = {
      reference: content.reference ?? '',
      number: content.number ?? '',
      version: content.version ?? '',
      count: content.count ?? '',
      hash: content.hash ?? '',
      day: content.day ? formatDay(content.day, envelope.locale) : '',
    };
    subject = say(text.subject, values);
    body.push({ kind: 'text', text: say(text.body, values) });
    body.push({ kind: 'link', text: w.open, href: content.href });
  } else if (content.category === 'sign_in_code') {
    subject = w.signInCode.subject;
    body.push({ kind: 'text', text: say(w.signInCode.body, { code: content.code }) });
    body.push({ kind: 'text', text: say(w.signInCode.expires, { count: content.minutes }) });
    // Its own footer: an external reviewer is no member of the
    // organization, and a code is about no record (language review 10).
    return finish(subject, body, [
      { kind: 'text', text: say(w.signInCode.footer, { organization: oneLine(envelope.organization) }) },
    ]);
  } else if (content.category === 'weekly_digest' && content.topic === 'risks') {
    subject = w.weeklyRisks.subject;
    body.push({ kind: 'text', text: w.weeklyRisks.body });
    if (content.reviewsOverdue > 0) {
      body.push({ kind: 'text', text: say(w.weeklyRisks.reviewsOverdue, { count: content.reviewsOverdue }) });
    }
    if (content.actionsOverdue > 0) {
      body.push({ kind: 'text', text: say(w.weeklyRisks.actionsOverdue, { count: content.actionsOverdue }) });
    }
    if (content.stepsOverdue > 0) {
      body.push({ kind: 'text', text: say(w.weeklyRisks.stepsOverdue, { count: content.stepsOverdue }) });
    }
    body.push({ kind: 'link', text: w.weeklyRisks.open, href: content.href });
  } else if (content.category === 'weekly_digest') {
    // Acknowledgements first, as before; the approval steps as a line of
    // their own, or alone when no acknowledgement is overdue. The subject
    // names what is overdue (language review 8, A3).
    const acks = content.overdue > 0;
    const steps = content.stepsOverdue > 0;
    subject = acks
      ? steps
        ? w.weekly.bothSubject
        : w.weekly.subject
      : w.weekly.stepsSubject;
    body.push({ kind: 'text', text: acks ? w.weekly.body : w.weekly.stepsBody });
    if (acks) {
      body.push({ kind: 'text', text: say(w.weekly.overdue, { overdue: content.overdue }) });
      body.push({ kind: 'text', text: say(w.weekly.people, { people: content.people }) });
    }
    if (content.stepsOverdue > 0) {
      body.push({ kind: 'text', text: say(w.weekly.stepsOverdue, { count: content.stepsOverdue }) });
    }
    // To the late acknowledgements when there are any, else to the overdue
    // steps (language review 8, M6): `href` is chosen so by the worker.
    body.push({ kind: 'link', text: acks ? w.weekly.open : w.weekly.openSteps, href: content.href });
  } else {
    const day = formatDay(content.day, envelope.locale);
    subject = fill(w.daily.subject, { day: rtl ? `${FSI}${day}${PDI}` : day });
    body.push({ kind: 'text', text: w.daily.intro });
    for (const section of content.sections) {
      body.push({ kind: 'text', text: say(w.daily[section.key], { count: section.count }) });
      if (section.overdueCount) {
        body.push({
          kind: 'text',
          text: say(w.daily.incidentsOverdue, { count: section.overdueCount }),
        });
      }
      const shown = section.items.slice(0, DIGEST_ITEMS);
      body.push({ kind: 'list', items: shown });
      if (section.count > shown.length) {
        body.push({
          kind: 'text',
          text: say(w.daily.more, { count: section.count - shown.length }),
        });
      }
    }
    body.push({ kind: 'link', text: w.daily.open, href: content.href });
  }

  const footer: Paragraph[] = [
    { kind: 'text', text: say(w.footer.member, { organization: oneLine(envelope.organization) }) },
    { kind: 'text', text: w.footer.noDetails },
  ];
  if (envelope.preferencesHref) {
    footer.push({ kind: 'link', text: w.footer.preferences, href: envelope.preferencesHref });
  }
  if (envelope.unsubscribe) {
    footer.push({
      kind: 'link',
      text:
        envelope.unsubscribe.switch === 'immediate'
          ? w.footer.unsubscribeImmediate
          : w.footer.unsubscribeDigest,
      href: envelope.unsubscribe.href,
    });
  }

  return finish(subject, body, footer);

  function finish(title: string, main: Paragraph[], end: Paragraph[]): RenderedMail {
    const line = oneLine(title);
    return {
      subject: line,
      text: renderText(main, end, w),
      html: renderHtml(line, main, end, envelope.locale, w),
    };
  }
}

function itemText(item: DigestItem, w: Wording, rtl: boolean) {
  const label = rtl ? `${LRI}${item.label}${PDI}` : item.label;
  return `${label}${item.overdue ? ` (${w.overdue})` : ''}`;
}

function renderText(body: Paragraph[], footer: Paragraph[], w: Wording) {
  const rtl = w.dir === 'rtl';
  const block = (p: Paragraph) => {
    if (p.kind === 'text') return p.text;
    if (p.kind === 'code') return rtl ? `${LRI}${p.text}${PDI}` : p.text;
    if (p.kind === 'link') return `${p.text}${w.colon}${p.href}`;
    return p.items.map((item) => `- ${itemText(item, w, rtl)}${w.colon}${item.href}`).join('\n');
  };
  return [
    ...body.map(block).filter((b) => b !== ''),
    '--',
    footer.map(block).join('\n'),
  ].join('\n\n') + '\n';
}

const LINK_STYLE = 'color:#0b5cad;text-decoration:underline';

function renderHtml(
  subject: string,
  body: Paragraph[],
  footer: Paragraph[],
  locale: Locale,
  w: Wording,
) {
  const block = (p: Paragraph, small = false) => {
    const style = small
      ? ' style="margin:0 0 8px;font-size:12px;color:#52606d"'
      : ' style="margin:0 0 16px"';
    if (p.kind === 'text') return `<p${style}>${escapeHtml(p.text)}</p>`;
    if (p.kind === 'code') {
      return `<p dir="ltr" style="margin:0 0 16px;font-family:monospace;word-break:break-all">${escapeHtml(p.text)}</p>`;
    }
    if (p.kind === 'link') {
      return `<p${style}><a href="${escapeHtml(p.href)}" style="${LINK_STYLE}">${escapeHtml(p.text)}</a></p>`;
    }
    if (p.items.length === 0) return '';
    return `<ul style="margin:0 0 16px">${p.items
      .map(
        (item) =>
          `<li><a href="${escapeHtml(item.href)}" style="${LINK_STYLE}"><bdi dir="ltr">${escapeHtml(item.label)}</bdi></a>${item.overdue ? ` (${escapeHtml(w.overdue)})` : ''}</li>`,
      )
      .join('')}</ul>`;
  };
  return [
    '<!DOCTYPE html>',
    `<html lang="${locale}" dir="${w.dir}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    `<body dir="${w.dir}" style="margin:0;padding:24px;background:#ffffff;color:#1f2933;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">`,
    '<div style="max-width:560px">',
    ...body.map((p) => block(p)),
    '<hr style="border:none;border-top:1px solid #d9e2ec;margin:24px 0 16px">',
    ...footer.map((p) => block(p, true)),
    '</div></body></html>',
  ].join('\n');
}
