import type { Locale } from '../i18n/locales.js';
import { escapeHtml } from './render.js';
import type { EmailSwitch } from './unsubscribe-token.js';
import { isLocale, WORDING } from './wording/index.js';

/**
 * The headers of an unsubscribe page: nothing is loaded from anywhere, it
 * is never framed or kept, and its address (which holds the token) is
 * never passed on as a referrer.
 */
export const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/** The language of a page for a link that is not valid: the browser's. */
export function pageLocale(acceptLanguage: string | undefined): Locale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0].trim().slice(0, 2).toLowerCase();
    if (isLocale(tag)) return tag;
  }
  return 'en';
}

function page(locale: Locale, paragraphs: string[], form = '') {
  const w = WORDING[locale];
  return [
    '<!DOCTYPE html>',
    `<html lang="${locale}" dir="${w.dir}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(w.page.title)}</title></head>`,
    '<body style="margin:0;padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1f2933;background:#ffffff">',
    '<main style="max-width:480px">',
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(w.page.title)}</h1>`,
    ...paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`),
    form,
    '</main></body></html>',
  ].join('\n');
}

/**
 * Asks to confirm with one button. A plain visit changes nothing, because
 * the link scanners of mail systems visit links. The button posts the
 * form a mail client's own unsubscribe button posts (RFC 8058).
 */
export function confirmPage(locale: Locale, which: EmailSwitch) {
  const w = WORDING[locale];
  return page(
    locale,
    // The emails that stay on, whoever asks (business decision 4): said
    // the same to everyone, so the page tells nothing of the person.
    which === 'immediate'
      ? [w.page.confirmImmediate, w.page.alwaysOn]
      : [w.page.confirmDigest],
    `<form method="post" action=""><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="font-size:16px;padding:8px 16px">${escapeHtml(w.page.button)}</button></form>`,
  );
}

/** Done. Says nothing of the person, their address or their organization. */
export function donePage(locale: Locale, which: EmailSwitch) {
  const w = WORDING[locale];
  return page(locale, [
    which === 'immediate' ? w.page.doneImmediate : w.page.doneDigest,
    ...(which === 'immediate' ? [w.page.alwaysOn] : []),
    w.page.turnBackOn,
  ]);
}

/** For a link that is not valid, altered or expired: nothing more. */
export function invalidPage(locale: Locale) {
  return page(locale, [WORDING[locale].page.invalid]);
}
