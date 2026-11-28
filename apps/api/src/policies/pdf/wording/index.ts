import type { Locale } from '../../../i18n/locales.js';
import { ar } from './ar.js';
import { en } from './en.js';
import { fr } from './fr.js';
import type { PdfWording } from './types.js';

export type { PdfWording } from './types.js';
export const PDF_WORDING: Record<Locale, PdfWording> = { en, ar, fr };
