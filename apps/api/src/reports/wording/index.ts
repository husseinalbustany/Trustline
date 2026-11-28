import type { Locale } from '../../i18n/locales.js';
import { ar } from './ar.js';
import { en } from './en.js';
import { fr } from './fr.js';
import type { ReportsWording } from './types.js';

export const REPORTS_WORDING: Record<Locale, ReportsWording> = { en, ar, fr };
