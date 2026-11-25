import { addDays } from '../i18n/time-zones.js';
import { ruleLevelOf, type HarmLevel } from './status.js';

/** How long a hospital allows itself for one harm level. */
export type ResponseRule = {
  /** Hours on the clock from the report to its triage. */
  triageWithinHours: number;
  /** Days on the hospital's calendar from the report to its closure. */
  closeWithinDays: number;
};

export type ResponseRules = Record<HarmLevel, ResponseRule>;

/** In order of severity, as the settings screen lists them. */
export const HARM_LEVELS: HarmLevel[] = [
  'none',
  'mild',
  'moderate',
  'severe',
  'death',
];

export const RULE_LIMITS = {
  triageWithinHours: { min: 1, max: 720 },
  closeWithinDays: { min: 1, max: 365 },
} as const;

/**
 * The response rules every client starts with, and is expected to change.
 * Like the default categories they are only ever added, never overwritten.
 * Migration 0023 gave the same values to the clients that existed before.
 */
export const DEFAULT_RESPONSE_RULES: ResponseRules = {
  none: { triageWithinHours: 72, closeWithinDays: 30 },
  mild: { triageWithinHours: 72, closeWithinDays: 30 },
  moderate: { triageWithinHours: 48, closeWithinDays: 30 },
  severe: { triageWithinHours: 24, closeWithinDays: 45 },
  death: { triageWithinHours: 24, closeWithinDays: 45 },
};

type Gravity = { harmLevel: HarmLevel; isSentinel: boolean };

/**
 * When an incident reported at this moment should be triaged by, under the
 * rule for its gravity. Hours are hours on the clock.
 */
export const triageDueAt = (
  reportedAt: Date,
  incident: Gravity,
  rules: ResponseRules,
) =>
  new Date(
    reportedAt.getTime() +
      rules[ruleLevelOf(incident)].triageWithinHours * 3_600_000,
  );

/**
 * When it should be closed by: the same time of day, that many days later on
 * the hospital's own calendar.
 */
export const closeDueAt = (
  reportedAt: Date,
  incident: Gravity,
  rules: ResponseRules,
  timeZone: string,
) => addDays(reportedAt, rules[ruleLevelOf(incident)].closeWithinDays, timeZone);
