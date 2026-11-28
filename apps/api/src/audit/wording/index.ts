import type { Locale } from '../../i18n/locales.js';
import { ar } from './ar.js';
import { en } from './en.js';
import { fr } from './fr.js';
import type { AuditWording } from './types.js';

export const AUDIT_WORDING: Record<Locale, AuditWording> = { en, ar, fr };
