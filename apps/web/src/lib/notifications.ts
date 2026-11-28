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
    overdue?: number;
    people?: number;
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

/** About no one document: the overdue acknowledgements of the week. */
export const overdueDigest = "acknowledgements_overdue_digest";

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
): string {
  const general = kinds.other as string;
  // The weekly summary: overdue acknowledgements, overdue approval steps,
  // or both, whichever it counts.
  if (kind === overdueDigest) {
    const wording = kinds[kind];
    if (typeof wording === "string") return wording;
    const acks = (data?.overdue ?? 0) > 0;
    const steps = (data?.stepsOverdue ?? 0) > 0;
    return (
      wording[acks && steps ? "both" : steps ? "steps" : "acknowledgements"] ??
      general
    );
  }
  // A review that is a re-issue has its own words, when there are any.
  const own = `${kind}_reissue`;
  const wording =
    data?.reissue === true && Object.hasOwn(kinds, own)
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
