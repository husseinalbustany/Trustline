import { ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { moduleStarts, policyImportWindows } from '../database/schema.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';

/**
 * How long a client may import its existing documents, from the day the
 * policies module was first switched on, unless Trustline's staff set
 * another last day (security review 7, finding 2): the 90th day, counting
 * the first.
 */
export const IMPORT_WINDOW_DAYS = 90;

export type ImportWindow = {
  /** The day the policies module was first switched on for the client. */
  startedOn: string;
  /** The last day imports are accepted. */
  closesOn: string;
  /** The latest approval day an imported document may have. */
  latestApprovedOn: string;
  open: boolean;
  /** Whether Trustline's staff set `closesOn`, rather than the default. */
  setByTrustline: boolean;
  /** Whether the module's first day is recorded (it is, once switched on). */
  startRecorded: boolean;
};

/**
 * The default last day of the window, for a module first switched on on
 * `startedOn`.
 */
export const defaultClosesOn = (startedOn: string) =>
  shiftDay(startedOn, IMPORT_WINDOW_DAYS - 1);

/**
 * Imports are for migrating what a client had before Trustline, not a way
 * around the approval route. So they are accepted only while the window is
 * open, and only of documents approved before the module was first
 * switched on.
 *
 * On the client's calendar, in a transaction of the client's (or of the
 * admin portal, which names the client). With no recorded start (the
 * database records one whenever the module is switched on, so a client
 * that has it has one), today stands for it: nothing approved from today
 * on.
 */
export async function importWindowOf(
  tx: Transaction | Database,
  tenant: { id: string; timeZone: string },
  now = new Date(),
): Promise<ImportWindow> {
  const today = dayOf(now, tenant.timeZone);
  const [start] = await tx
    .select({ startedOn: moduleStarts.startedOn })
    .from(moduleStarts)
    .where(
      and(eq(moduleStarts.tenantId, tenant.id), eq(moduleStarts.module, 'policies')),
    );
  const startedOn = start?.startedOn ?? today;
  const [set] = await tx
    .select({ closesOn: policyImportWindows.closesOn })
    .from(policyImportWindows)
    .where(eq(policyImportWindows.tenantId, tenant.id));
  const closesOn = set?.closesOn ?? defaultClosesOn(startedOn);
  return {
    startedOn,
    closesOn,
    latestApprovedOn: shiftDay(startedOn, -1),
    open: today <= closesOn,
    setByTrustline: !!set,
    startRecorded: !!start,
  };
}

/**
 * 403 `import_window_closed`, with the window's last day (`closedOn`) and
 * the latest approval day a document may have, once the window has closed.
 */
export function assertImportWindowOpen(window: ImportWindow) {
  if (window.open) return;
  throw new ForbiddenException({
    code: 'import_window_closed',
    closedOn: window.closesOn,
    latestApprovedOn: window.latestApprovedOn,
    startedOn: window.startedOn,
  });
}

/** What the screens are shown of the window. */
export const importWindowView = (w: ImportWindow) => ({
  startedOn: w.startedOn,
  closesOn: w.closesOn,
  latestApprovedOn: w.latestApprovedOn,
  open: w.open,
});
