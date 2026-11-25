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
  incident: {
    id: string;
    reference: string;
    /** False once the reader can no longer see the incident. */
    canOpen: boolean;
  };
  data: {
    reference?: string;
    /** With `due_soon` and `overdue`. */
    deadline?: string;
    /** With `sign_off_decided`. */
    decision?: string;
    /** With `status_changed`. */
    change?: string;
  } | null;
};

export type NotificationList = { items: Notification[]; total: number };

/** What says more about each kind, beyond the kind itself. */
const detailOf = {
  due_soon: "deadline",
  overdue: "deadline",
  sign_off_decided: "decision",
  status_changed: "change",
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
  const wording = Object.hasOwn(kinds, kind) ? kinds[kind] : general;
  if (typeof wording === "string") return wording;
  const detail = Object.hasOwn(detailOf, kind)
    ? data?.[detailOf[kind as keyof typeof detailOf]]
    : undefined;
  return detail && Object.hasOwn(wording, detail)
    ? wording[detail]
    : (wording.other ?? general);
}
