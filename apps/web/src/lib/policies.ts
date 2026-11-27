import type { Localized } from "./localized";

/**
 * The policies module as the API gives it: controlled documents, their
 * versions, approvals, acknowledgements and periodic reviews. What the
 * caller may do is always the API's `moves`; nothing here knows the rules.
 */

export const documentStatuses = ["draft", "active", "retired"] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

export const versionStatuses = [
  "draft",
  "in_review",
  "approved",
  "published",
  "superseded",
  "withdrawn",
] as const;
/** May be a status added to the API after this app was built. */
export type VersionStatus = (typeof versionStatuses)[number] | (string & {});

export type Confidentiality = "all_staff" | "restricted";
export type ReviewState = "due" | "overdue" | null;

/** A person or a unit as a record names them. The name may be gone. */
export type Named = { id: string; name: Localized | null };

export type Section = { key: string; name: Localized; required: boolean };

export type DocumentType = {
  id: string;
  code: string;
  name: Localized;
  numberPrefix: string;
  sections: Section[];
  defaultReviewMonths: number;
  active: boolean;
  position: number;
  revision: number;
};

export type DocumentCategory = {
  id: string;
  code: string;
  name: Localized;
  parentId: string | null;
  active: boolean;
  position: number;
  revision: number;
};

type Kind = { id: string; code: string; name: Localized };

export type DocumentMove =
  | "edit"
  | "new_version"
  | "retire"
  | "confirm_review"
  | (string & {});

export type VersionMove =
  | "edit"
  | "submit"
  | "recall"
  | "publish"
  | "withdraw"
  | "approve"
  | "return"
  | "acknowledge"
  | (string & {});

export type PolicyDocument = {
  id: string;
  number: string;
  title: Localized;
  type: Kind;
  category: Kind;
  owner: Named;
  ownerUnit: Named;
  confidentiality: Confidentiality;
  audience: {
    wholeOrganization: boolean;
    orgUnits: Named[];
    roles: Named[];
  };
  keywords: string[];
  references: string[];
  reviewMonths: number;
  /** Days on the client's calendar, "2026-11-27". */
  nextReviewOn: string | null;
  lastReviewedOn: string | null;
  review: ReviewState;
  status: DocumentStatus;
  retiredAt: string | null;
  retiredBy: Named | null;
  retireReason: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  access: "full" | "reader" | "assignee";
  published: {
    id: string;
    version: number;
    effectiveOn: string | null;
    publishedAt: string | null;
    acknowledgementRequired: boolean;
  } | null;
  inProgress: { id: string; version: number; status: VersionStatus } | null;
  myAcknowledgement: MyAcknowledgement | null;
  /** Today on the client's calendar. */
  today: string;
  moves: DocumentMove[];
};

export type MyAcknowledgement = {
  versionId: string;
  dueOn: string | null;
  acknowledgedAt: string | null;
  overdue: boolean;
};

export type DocumentListItem = {
  id: string;
  number: string;
  title: Localized;
  type: Kind;
  category: Kind;
  ownerUnit: Named;
  status: DocumentStatus;
  confidentiality: Confidentiality;
  /** Of the published version; null before the first is published. */
  version: number | null;
  effectiveOn: string | null;
  publishedAt: string | null;
  nextReviewOn: string | null;
  inProgress: { id: string; version: number; status: VersionStatus } | null;
  review: ReviewState;
  access: "full" | "other";
  myAcknowledgement: { dueOn: string | null; overdue: boolean } | null;
};

export type DocumentList = { items: DocumentListItem[]; total: number };

export type StepKind = "review" | "approve";

export type Assignee =
  | { type: "user"; user: Named | null }
  | { type: "role"; role: Named };

export type RunStep = {
  position: number;
  kind: StepKind;
  assignee: Assignee;
  status: "waiting" | "pending" | "approved" | "returned" | "skipped";
  dueAt: string | null;
  overdue: boolean;
  decidedBy: Named | null;
  decidedAt: string | null;
  comment: string | null;
};

export type DiffLine = { op: "same" | "added" | "removed"; text: string };

export type SectionComparison = {
  key: string;
  name: Localized;
  required: boolean;
  changed: boolean;
  locales: Record<string, { changed: boolean; lines: DiffLine[] }>;
};

/**
 * Where a section stands in one language, against the authoritative one:
 * written; not written, so its readers are shown the authoritative text
 * (`fallback`); written, but not updated since the authoritative text
 * changed (`lagging`); or written in neither (`empty`).
 */
export type SectionLanguageState =
  | "written"
  | "fallback"
  | "lagging"
  | "empty"
  | (string & {});

export type LanguageStatus = {
  /** The language whose text applies where two languages differ. */
  authoritative: string;
  /** The version published before this one, which it was compared with. */
  comparedWith: { id: string; version: number } | null;
  sections: { key: string; locales: Record<string, SectionLanguageState> }[];
  byLocale: Record<
    string,
    { written: number; fallback: number; lagging: number; empty: number }
  >;
  lagging: boolean;
};

export type Run = {
  id: string;
  status: "in_progress" | "approved" | "returned" | "cancelled" | (string & {});
  currentPosition: number;
  startedAt: string;
  completedAt: string | null;
  steps: RunStep[];
};

/** Per language, per section key: the section's text. */
export type Content = Record<string, Record<string, string>>;

export type Approval = {
  position: number;
  kind: StepKind;
  meaning: "reviewed" | "approved" | (string & {}) | null;
  signedBy: Named | null;
  signedAt: string | null;
  contentHash: string | null;
};

export type DocumentVersion = {
  id: string;
  documentId: string;
  number: string;
  title: Localized;
  version: number;
  status: VersionStatus;
  sections: Section[];
  content: Content;
  /** The languages it has text in, the client's default first. */
  languages: string[];
  contentHash: string;
  changeSummary: Localized | null;
  preparedBy: Named | null;
  preparedAt: string | null;
  effectiveOn: string | null;
  scheduledFor: string | null;
  scheduledBy: Named | null;
  approvedAt: string | null;
  publishedAt: string | null;
  publishedBy: Named | null;
  supersededAt: string | null;
  withdrawnAt: string | null;
  acknowledgementRequired: boolean;
  acknowledgeWithinDays: number;
  languageStatus: LanguageStatus | null;
  today: string;
  control: {
    number: string;
    version: number;
    status: VersionStatus;
    documentStatus: DocumentStatus;
    /** The one copy a print may call controlled. */
    inForce: boolean;
    owner: Named;
    effectiveOn: string | null;
    nextReviewOn: string | null;
    approvals: Approval[];
  };
  run: Run | null;
  /** Every round of review, newest first, for those who see the runs. */
  rounds: (Run & { snapshot: boolean })[];
  returned: {
    position: number;
    comment: string | null;
    by: Named | null;
    at: string | null;
  }[];
  comparison: SectionComparison[] | null;
  /** Compared with what it held when it was last returned. */
  sinceReturned: {
    runId: string;
    returnedAt: string | null;
    changeSummaryChanged: boolean;
    comparison: SectionComparison[];
  } | null;
  myStep: {
    position: number;
    kind: StepKind;
    dueAt: string | null;
    samePerson: boolean;
  } | null;
  myAcknowledgement: MyAcknowledgement | null;
  revision: number;
  moves: VersionMove[];
};

export type History = {
  versions: {
    id: string;
    version: number;
    status: VersionStatus;
    changeSummary: Localized | null;
    preparedAt: string | null;
    effectiveOn: string | null;
    publishedAt: string | null;
    supersededAt: string | null;
    withdrawnAt: string | null;
  }[];
  reviews: {
    id: string;
    dueOn: string | null;
    outcome: "no_change" | "revised" | "retired" | (string & {});
    comment: string | null;
    reviewedBy: Named | null;
    reviewedAt: string | null;
    nextReviewOn: string | null;
    signatureId: string | null;
  }[];
};

export type ApprovalItem = {
  stepId: string;
  position: number;
  kind: StepKind;
  dueAt: string | null;
  activatedAt: string | null;
  overdue: boolean;
  document: { id: string; number: string; title: Localized };
  type: Kind;
  version: { id: string; version: number; revision: number };
};

export type ReviewItem = {
  id: string;
  number: string;
  title: Localized;
  ownerId: string;
  ownerUnit: Named;
  nextReviewOn: string;
  revision: number;
  mine: boolean;
  state: "due" | "overdue";
};

export type Measure = {
  percent: number | null;
  target: number;
  /** Null when there is nothing to measure yet. */
  met: boolean | null;
};

export type PolicySummary = {
  today: string;
  active: number;
  pastReview: Measure & { count: number; of: number };
  dueWithin30Days: number;
  awaitingMyApproval: number;
  awaitingMyAcknowledgement: number;
  /**
   * Of the acknowledgements whose due date has passed, the share given;
   * `live` is the same over everyone asked today. Null for those who may
   * not see acknowledgement figures.
   */
  acknowledgement:
    | (Measure & {
        basis: "due_date_passed" | (string & {});
        targeted: number;
        acknowledged: number;
        live: { targeted: number; acknowledged: number; percent: number | null };
      })
    | null;
};

export type AcknowledgementFigures = {
  versionId: string;
  version: number;
  status: VersionStatus;
  acknowledgementRequired: boolean;
  targeted: number;
  acknowledged: number;
  pending: number;
  overdue: number;
  percent: number | null;
  byUnit: {
    orgUnit: Named | null;
    targeted: number;
    acknowledged: number;
    overdue: number;
    percent: number | null;
  }[];
  people: {
    items: {
      user: Named;
      orgUnit: Named | null;
      assignedAt: string;
      dueOn: string;
      acknowledgedAt: string | null;
      overdue: boolean;
      /** No longer an active user: kept as evidence, not counted. */
      left: boolean;
    }[];
    total: number;
  };
};

/** A role as the document settings and forms may name it. */
export type PolicyRole = {
  id: string;
  code: string;
  name: Localized;
  isSystem: boolean;
  /** Whether it may be named in an approval step. */
  approves: boolean;
};

export type PolicySettings = { maxReviewMonths: number; revision: number };

export type ChangeField =
  | "title"
  | "category"
  | "owner"
  | "ownerUnit"
  | "audience"
  | "confidentiality"
  | "reviewMonths"
  | "nextReviewOn"
  | "keywords"
  | "references";

/** A change to a document's details, as its history shows it. */
export type DocumentChange = {
  id: string;
  at: string;
  by: Named | null;
  reason: string | null;
  changes: { field: ChangeField | (string & {}); from: unknown; to: unknown }[];
};

export type OverdueList = {
  today: string;
  items: {
    user: Named;
    orgUnit: Named | null;
    /** Null, with the version, for a document the reader may not open. */
    document: {
      id: string;
      number: string;
      title: Localized | null;
      canOpen: boolean;
    } | null;
    version: { id: string; version: number } | null;
    dueOn: string;
    daysOverdue: number;
  }[];
  total: number;
};

export type Person = { id: string; name: Localized; orgUnitId: string | null };

export type RouteStep = {
  position: number;
  kind: StepKind;
  assignee: Assignee;
  dueInDays: number;
};

export type ApprovalRoute = {
  id: string;
  name: Localized;
  subject: string;
  documentTypeId: string | null;
  active: boolean;
  revision: number;
  steps: RouteStep[];
};

/** The largest section and version the API takes, in characters. */
export const SECTION_MAX = 20_000;
export const VERSION_MAX = 200_000;

/** The library's sort orders, as the API names them. */
export const librarySorts = [
  "number",
  "title",
  "next_review",
  "recently_published",
] as const;
export type LibrarySort = (typeof librarySorts)[number];

export type LibraryFilters = {
  q: string;
  typeId: string;
  categoryId: string;
  ownerUnitId: string;
  status: "" | DocumentStatus;
  review: "" | "due" | "overdue";
  appliesToMe: boolean;
  awaitingMyAcknowledgement: boolean;
  sort: LibrarySort;
  page: number;
};

export const noLibraryFilters: LibraryFilters = {
  q: "",
  typeId: "",
  categoryId: "",
  ownerUnitId: "",
  status: "",
  review: "",
  appliesToMe: false,
  awaitingMyAcknowledgement: false,
  sort: "number",
  page: 1,
};

const oneOf = <T extends string>(list: readonly T[], value: string | null) =>
  value !== null && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

const uuid = (value: string | null) =>
  value && /^[0-9a-f-]{36}$/i.test(value) ? value : "";

/** The library's filters, from its address. Anything unreadable is left out. */
export function readLibraryFilters(params: {
  get(name: string): string | null;
}): LibraryFilters {
  const page = Number(params.get("page"));
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    typeId: uuid(params.get("typeId")),
    categoryId: uuid(params.get("categoryId")),
    ownerUnitId: uuid(params.get("ownerUnitId")),
    status: oneOf(documentStatuses, params.get("status")) ?? "",
    review: oneOf(["due", "overdue"] as const, params.get("review")) ?? "",
    appliesToMe: params.get("appliesToMe") === "true",
    awaitingMyAcknowledgement:
      params.get("awaitingMyAcknowledgement") === "true",
    sort: oneOf(librarySorts, params.get("sort")) ?? "number",
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

/** Only what differs from the plain library is written in the address. */
export function libraryQuery(filters: Partial<LibraryFilters>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries({
    ...noLibraryFilters,
    ...filters,
  })) {
    if (value !== noLibraryFilters[name as keyof LibraryFilters]) {
      query.set(name, String(value));
    }
  }
  return query.toString();
}

export function libraryPath(
  lang: string,
  filters: Partial<LibraryFilters> = {},
): string {
  const query = libraryQuery(filters);
  return `/${lang}/policies${query ? `?${query}` : ""}`;
}

/** The master list as a CSV file, with the library's filters and order. */
export function documentsExportPath(
  filters: LibraryFilters,
  locale: string | null,
): string {
  const query = new URLSearchParams(libraryQuery({ ...filters, page: 1 }));
  if (locale) query.set("locale", locale);
  const text = query.toString();
  return `/policies/exports/documents${text ? `?${text}` : ""}`;
}

export const documentPath = (lang: string, id: string) =>
  `/${lang}/policies/${id}`;

export const versionPath = (lang: string, id: string, versionId: string) =>
  `/${lang}/policies/${id}/versions/${versionId}`;

/**
 * The language a version is shown in: the one asked for if the version has
 * it, else the reader's, else the first it has (the client's default comes
 * first). Null when it has no text yet.
 */
export function shownLanguage(
  languages: string[],
  asked: string | null,
  reader: string,
): string | null {
  if (asked && languages.includes(asked)) return asked;
  if (languages.includes(reader)) return reader;
  return languages[0] ?? null;
}

export type NotInForce = "retired" | "superseded" | "withdrawn" | "unpublished";

/**
 * Why a version is not the one in force, or null for the one the API says
 * is in force (`control.inForce`). A retired document's versions are all
 * out of force, whatever each one's own status.
 */
export function notInForce(
  document: Pick<PolicyDocument, "status">,
  version: Pick<DocumentVersion, "status" | "control">,
): NotInForce | null {
  if (version.control.inForce) return null;
  if (document.status === "retired") return "retired";
  if (version.status === "superseded") return "superseded";
  if (version.status === "withdrawn") return "withdrawn";
  // Published but before its day, or anything not yet published.
  return "unpublished";
}

/** Today on the client's calendar, as the API writes a day. */
export function todayIn(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Bytes of a request body, as the API counts them against its 100 kB. */
export const bodySize = (body: unknown) =>
  new TextEncoder().encode(JSON.stringify(body)).length;

/** What one request may carry, with room under the API's limit. */
export const BODY_BUDGET = 90_000;

/**
 * Changed sections, split into requests that each stay under the body
 * limit: a long version is saved a few sections at a time.
 */
export function contentChunks(
  changes: { locale: string; key: string; text: string | null }[],
): Record<string, Record<string, string | null>>[] {
  const chunks: Record<string, Record<string, string | null>>[] = [];
  let current: Record<string, Record<string, string | null>> = {};
  let empty = true;
  for (const change of changes) {
    const next = {
      ...current,
      [change.locale]: { ...current[change.locale], [change.key]: change.text },
    };
    if (!empty && bodySize({ content: next, revision: 1 }) > BODY_BUDGET) {
      chunks.push(current);
      current = { [change.locale]: { [change.key]: change.text } };
    } else {
      current = next;
    }
    empty = false;
  }
  if (!empty) chunks.push(current);
  return chunks;
}

/** Categories in the order of their tree, each under its parent. */
export function categoriesInOrder(list: DocumentCategory[]) {
  const ids = new Set(list.map((c) => c.id));
  const out: { category: DocumentCategory; depth: number }[] = [];
  const add = (parentId: string | null, depth: number) => {
    for (const category of [...list].sort((a, b) => a.position - b.position)) {
      const child = parentId
        ? category.parentId === parentId
        : !category.parentId || !ids.has(category.parentId);
      if (!child || out.some((o) => o.category.id === category.id)) continue;
      out.push({ category, depth });
      add(category.id, depth + 1);
    }
  };
  add(null, 0);
  return out;
}
