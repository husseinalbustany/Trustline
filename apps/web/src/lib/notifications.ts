import type { Localized } from "./localized";

/**
 * Something that happened on an incident, told to one person. It carries
 * the incident's reference and a word or two about what happened, and never
 * a name, a description or what someone wrote: the details are in the
 * incident, for whoever may open it.
 */
export type Notification = {
  id: string;
  /** May be a kind added to the API after this app was built. */
  kind: string;
  createdAt: string;
  readAt: string | null;
  /**
   * Null for one about the organization itself, not an incident
   * (`public_form_paused`).
   */
  incident: {
    id: string;
    reference: string;
    /** False once the reader can no longer see the incident. */
    canOpen: boolean;
  } | null;
  /**
   * Null for one about anything but a controlled document. The title is
   * given only while the reader can still open the document.
   */
  document: {
    id: string;
    number: string;
    title: Localized | null;
    canOpen: boolean;
  } | null;
  /**
   * The person one is about (`policies_import_granted`), by their name now;
   * null for any other, or when the name is gone.
   */
  person?: { id: string; name: Localized | null } | null;
  data: {
    reference?: string;
    /** With a document's: its number, the version and the day it is about. */
    number?: string;
    version?: number;
    /** With every notification about one version: which. */
    versionId?: string;
    dueOn?: string;
    /** With `document_publish_failed`: the day it was to be published. */
    effectiveOn?: string;
    /** With `document_step_overdue`: the step's place in the route. */
    position?: number;
    /** With `acknowledgements_overdue_digest`: approval steps overdue. */
    stepsOverdue?: number;
    /** With `acknowledgements_overdue_digest`: how many, and for how many people. */
    /**
     * A count with the weekly summary; with `import_confirmation_due`,
     * whether the owner's confirmation is overdue.
     */
    overdue?: number | boolean;
    people?: number;
    /** With `document_owner_assigned`: the day the owner's confirmation is due. */
    confirmationDueOn?: string;
    /** With `signing_pin_changed`: set, changed or reset. */
    action?: string;
    /**
     * With `review_approval_turned_off`: the document type changed, and its
     * name as it was then, for a type no longer listed.
     */
    typeId?: string;
    typeCode?: string;
    typeName?: Localized;
    /** With `audit_chain_broken`: what the daily check found. */
    kind?: string;
    /** With `audit_chain_broken`: the first entry that does not hold, when known. */
    firstBadSeq?: number;
    /** With the AI notices: which features, and how much of an allowance is used. */
    feature?: string;
    features?: string;
    used?: number;
    allowance?: number | null;
    resetsOn?: string;
    /** With `audit_chain_head`: the week's last entry checked, and its seal. */
    seq?: number;
    hash?: string;
    checkedOn?: string;
    /** With `document_step_assigned`: review or approve. */
    step?: string;
    /** With `review_due`: 60, 30 or 7 days before. */
    days?: number;
    /**
     * With `review_due` and `review_overdue`: the document was approved
     * before Trustline, so its review is a re-issue through the route.
     */
    reissue?: boolean;
    /**
     * About severe harm, a death or a sentinel event. Missing from those
     * written before the API said so: read as not serious.
     */
    serious?: boolean;
    /** With `public_form_paused`: the reports an hour the form takes. */
    limit?: number;
    /** With `due_soon` and `overdue`. */
    deadline?: string;
    /** With `sign_off_decided`. */
    decision?: string;
    /** With `status_changed`. */
    change?: string;
    /** With `email_turned_off`: which emails a link in one switched off. */
    switch?: string;
  } | null;
};

export type NotificationList = { items: Notification[]; total: number };

/**
 * The kinds about a version that someone must act on in the review: they
 * open the version itself, not the document's page.
 */
export const aboutReview = new Set([
  "document_step_assigned",
  "document_step_overdue",
  "document_returned",
  "document_approved",
  "document_publish_failed",
]);

/** A link in an email switched some emails off: the person's own setting. */
export const emailTurnedOff = "email_turned_off";

/**
 * Where the weekly summary leads: the late acknowledgements, or the late
 * approval steps when it counts only those.
 */
export const weeklySummaryPath = (lang: string, data: Notification["data"]) =>
  Number(data?.overdue ?? 0) === 0 && (data?.stepsOverdue ?? 0) > 0
    ? `/${lang}/policies/steps/overdue`
    : `/${lang}/policies/overdue`;

/** About no one document: the overdue acknowledgements of the week. */
export const overdueDigest = "acknowledgements_overdue_digest";

/** The audit trail no longer matches its seals: told to who may act on it. */
export const auditChainBroken = "audit_chain_broken";

/** What says more about each kind, beyond the kind itself. */
const detailOf = {
  due_soon: "deadline",
  overdue: "deadline",
  sign_off_decided: "decision",
  status_changed: "change",
  document_step_assigned: "step",
  document_step_overdue: "step",
  review_due: "days",
  email_turned_off: "switch",
  import_confirmation_due: "overdue",
  signing_pin_changed: "action",
  external_access_changed: "change",
} as const;

/** A sentence, or a set of them by what `data` adds, with `other` as a rest. */
type Wording = string | Record<string, string>;

/**
 * The sentence for a notification, still holding its `{reference}`. A kind
 * this app has no words for yet gets the general sentence: a raw code is
 * never shown.
 */
export function sentenceFor(
  kinds: Record<string, Wording>,
  { kind, data }: Pick<Notification, "kind" | "data">,
  /** What a broken audit trail was found to be, by `data.kind`. */
  breaks?: Record<string, string>,
): string {
  const general = kinds.other as string;
  // The audit trail broken: from which entry, when known, and what was
  // found, when this app has words for it (`{kind}`, from `breaks`).
  if (kind === auditChainBroken) {
    const wording = kinds[kind];
    if (typeof wording !== "object") return wording ?? general;
    const known = !!data?.kind && !!breaks && Object.hasOwn(breaks, data.kind);
    const variant = !known
      ? "other"
      : typeof data?.firstBadSeq === "number"
        ? "seq"
        : "noSeq";
    return wording[variant] ?? wording.other ?? general;
  }
  // The weekly summary: overdue acknowledgements, overdue approval steps,
  // or both, whichever it counts.
  if (kind === overdueDigest) {
    const wording = kinds[kind];
    if (typeof wording === "string") return wording;
    const acks = Number(data?.overdue ?? 0) > 0;
    const steps = (data?.stepsOverdue ?? 0) > 0;
    return (
      wording[acks && steps ? "both" : steps ? "steps" : "acknowledgements"] ??
      general
    );
  }
  // A review that is a re-issue has its own words, when there are any.
  // A review that is a re-issue, or an owner who must confirm an import,
  // has its own words, when there are any.
  const own = data?.confirmationDueOn ? `${kind}_confirm` : `${kind}_reissue`;
  const wording =
    (data?.reissue === true || data?.confirmationDueOn) && Object.hasOwn(kinds, own)
      ? kinds[own]
      : Object.hasOwn(kinds, kind)
        ? kinds[kind]
        : general;
  if (typeof wording === "string") return wording;
  const detail = Object.hasOwn(detailOf, kind)
    ? data?.[detailOf[kind as keyof typeof detailOf]]
    : undefined;
  return detail !== undefined && Object.hasOwn(wording, String(detail))
    ? wording[String(detail)]
    : (wording.other ?? general);
}
