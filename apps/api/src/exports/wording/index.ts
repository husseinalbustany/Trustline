import type { Locale } from '../../i18n/locales.js';
import { ar } from './ar.js';
import { en } from './en.js';
import { fr } from './fr.js';
import type { ExportWording } from './types.js';

export type { ExportWording } from './types.js';
export const EXPORT_WORDING: Record<Locale, ExportWording> = { en, ar, fr };
