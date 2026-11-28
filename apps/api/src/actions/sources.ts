import type { Transaction } from '../database/client.js';
import type { ModuleCode } from '../subscriptions/modules.js';

/** What can call for an action (docs/specs/actions.md). */
export type ActionSourceType = 'risk';

/** A source record as the engine needs it. */
export type SourceRecord = {
  id: string;
  /** Its reference, said in notifications (`RSK-2026-00012`). */
  reference: string;
  /** Its unit; null: the whole organization. */
  orgUnitId: string | null;
  /** Whoever owns it: told when an action is overdue or completed. */
  ownerId: string | null;
  /** Whether notifications about its actions are marked serious. */
  serious: boolean;
};

/**
 * What a source tells the engine of its records, registered by the module
 * the source belongs to (`ActionsService.register`). The engine imports no
 * module; modules import it, and keep their rules to themselves.
 */
export type ActionSourceRules = {
  /** The module whose actions these are: off, they are left alone. */
  module: ModuleCode;
  /** The record, in the caller's transaction, or null. */
  record(tx: Transaction, id: string): Promise<SourceRecord | null>;
  /** The active people who manage actions of this record. */
  managersOf(tx: Transaction, record: SourceRecord): Promise<string[]>;
};
