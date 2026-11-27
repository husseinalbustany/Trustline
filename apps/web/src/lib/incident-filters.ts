import {
  harmLevels,
  incidentStatuses,
  incidentTypes,
  sortOrders,
  type HarmLevel,
  type IncidentType,
  type KnownStatus,
  type SortOrder,
} from "./incidents";

/**
 * How the incidents list is narrowed and ordered. It lives in the address
 * of the page, under the names the API uses, so a filtered list can be
 * bookmarked, sent to a colleague, and is still there after a reload.
 */
export type IncidentFilters = {
  status: KnownStatus | "";
  /** Every status that is not an ending: what the dashboard counts as open. */
  open: boolean;
  /** Severe harm, a death or a sentinel event. */
  serious: boolean;
  /** Past the deadline for triage or for closure. */
  overdue: boolean;
  type: IncidentType | "";
  harmLevel: HarmLevel | "";
  /** Sentinel events only, everything but them, or both. */
  sentinel: "true" | "false" | "";
  /** Where it happened, or the department handling it. */
  orgUnitId: string;
  categoryId: string;
  /**
   * How it arrived: signed in, or through the public link. Only for those
   * who may see who reported something, and it finds only the incidents
   * whose reporter they are told of.
   */
  channel: "app" | "public" | "";
  /**
   * Days of reporting, `2026-11-25`, both included. They are days on the
   * hospital's calendar: the API counts them in the hospital's time zone.
   */
  from: string;
  to: string;
  /** The start of a reference, or all of it. */
  reference: string;
  mine: boolean;
  assignedToMe: boolean;
  sort: SortOrder;
  page: number;
};

export const noFilters: IncidentFilters = {
  status: "",
  open: false,
  serious: false,
  overdue: false,
  type: "",
  harmLevel: "",
  sentinel: "",
  orgUnitId: "",
  categoryId: "",
  channel: "",
  from: "",
  to: "",
  reference: "",
  mine: false,
  assignedToMe: false,
  sort: "newest",
  page: 1,
};

const oneOf = <T extends string>(
  allowed: readonly T[],
  value: string | null,
): T | "" =>
  (allowed as readonly string[]).includes(value ?? "") ? (value as T) : "";

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const idOrNothing = (value: string | null) =>
  value && uuid.test(value) ? value : "";

/** A real day written `YYYY-MM-DD`, or nothing. */
const day = (value: string | null) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : "";
};

/**
 * The filters an address asks for. An address can be typed or come from an
 * old bookmark, so anything in it that is not understood is left out rather
 * than sent to the API, which would refuse the whole request.
 */
export function readFilters(params: {
  get(name: string): string | null;
}): IncidentFilters {
  const page = Number(params.get("page"));
  const open = params.get("open") === "true";
  return {
    // "Open" is a group of statuses. Asked for together with one status, the
    // group is what is shown: the two are one choice on the screen.
    status: open ? "" : oneOf(incidentStatuses, params.get("status")),
    open,
    serious: params.get("serious") === "true",
    overdue: params.get("overdue") === "true",
    type: oneOf(incidentTypes, params.get("type")),
    harmLevel: oneOf(harmLevels, params.get("harmLevel")),
    sentinel: oneOf(["true", "false"] as const, params.get("sentinel")),
    orgUnitId: idOrNothing(params.get("orgUnitId")),
    categoryId: idOrNothing(params.get("categoryId")),
    channel: oneOf(["app", "public"] as const, params.get("channel")),
    from: day(params.get("from")),
    to: day(params.get("to")),
    reference: (params.get("reference") ?? "").trim().slice(0, 20),
    mine: params.get("mine") === "true",
    assignedToMe: params.get("assignedToMe") === "true",
    sort: oneOf(sortOrders, params.get("sort")) || "newest",
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

/**
 * The filters as a query string, for the page's address and for the API
 * alike. Only what differs from "everything, newest first" is written, so
 * the plain list keeps a plain address.
 */
export function filtersQuery(filters: Partial<IncidentFilters>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...noFilters, ...filters })) {
    if (value !== noFilters[name as keyof IncidentFilters]) {
      query.set(name, String(value));
    }
  }
  return query.toString();
}

/** The address of the incidents list, narrowed and ordered as asked. */
export function incidentsPath(
  lang: string,
  filters: Partial<IncidentFilters> = {},
): string {
  const query = filtersQuery(filters);
  return `/${lang}/incidents${query ? `?${query}` : ""}`;
}

/**
 * A reference holds letters, digits and hyphens only. Anything else can be
 * the start of no reference, so it finds nothing and is not sent.
 */
export const canBeReference = (text: string) => /^[A-Za-z0-9-]*$/.test(text);

/** How many of the filters behind "More filters" are in use. */
export const moreFiltersInUse = (filters: IncidentFilters) =>
  [
    filters.type,
    filters.harmLevel,
    filters.sentinel,
    filters.orgUnitId,
    filters.categoryId,
    filters.channel,
    filters.from,
    filters.to,
  ].filter(Boolean).length;

/** Whether anything narrows the list (its order and page do not). */
export const isNarrowed = (filters: IncidentFilters) =>
  filtersQuery({ ...filters, sort: "newest", page: 1 }) !== "";
