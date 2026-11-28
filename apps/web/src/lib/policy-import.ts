import type { OrgUnit } from "./identity";
import type { Localized } from "./localized";
import type {
  DocumentCategory,
  DocumentType,
  Person,
  PolicyRole,
} from "./policies";

/**
 * Importing documents approved before Trustline, from a form or a file.
 * Everything here is shape: the file is read, its codes and names are
 * turned into the ids the API takes, and the list is cut into batches the
 * API accepts. Whether a document may be imported is the API's to say
 * (`/policies/imports/check`).
 */

/** The most documents, and characters of text, one batch carries. */
export const IMPORT_MAX_DOCUMENTS = 20;
export const IMPORT_MAX_CHARACTERS = 600_000;
/** Bytes of one batch request, with room under the API's 2 MB. */
export const IMPORT_BODY_BUDGET = 1_900_000;

/** One document as the API's import routes take it. */
export type ImportDocument = {
  typeId: string;
  categoryId: string;
  title: Localized;
  ownerId: string;
  ownerUnitId: string;
  audience: { orgUnitIds: string[]; roleIds: string[] };
  confidentiality: string;
  keywords: string[];
  references: string[];
  reviewMonths?: unknown;
  number?: string;
  revisionLabel?: string;
  approvedOn: string;
  approvedBy: string;
  /** When the original was last reviewed, as it says. */
  lastReviewedOn?: string;
  originalKeptAt: Localized;
  /** What the text here does not reproduce of the original, per language. */
  differences?: Localized;
  effectiveOn?: string;
  nextReviewOn: string;
  content: Record<string, Record<string, string>>;
  acknowledgementRequired: unknown;
  acknowledgeWithinDays?: unknown;
};

/** What `/imports/check` says of a document it would import. */
export type CheckedDocument = {
  index: number;
  number: string | null;
  numberFrom: "given" | "trustline" | (string & {});
  /** The series it is numbered in, or whose counter a number given advances. */
  series: string | null;
  sectionsNotWritten: { key: string; required: boolean }[];
  acknowledgementRequired: boolean;
};

/** A document of a batch refused, and why, as the API says it. */
export type ImportProblem = {
  index: number;
  number: string | null;
  code: string;
  status: number;
} & Record<string, unknown>;

/** What `POST /imports` answers. */
export type ImportedBatch = {
  batch: { id: string; size: number; importedAt: string; listHash: string };
  documents: {
    index: number;
    id: string;
    number: string;
    numberFrom: string;
    versionId: string;
    sectionsNotWritten: { key: string; required: boolean }[];
    acknowledgementsAsked: number;
    signature: { id: string; meaning: string; signedAt: string; contentHash: string };
  }[];
};

// The file.

/**
 * The columns of a CSV file, and the fields of a JSON object, in the order
 * the layout page lists them. A column for each language follows its
 * field's name and a dot (`title.en`); a section's text, `section.`, its
 * key, a dot and the language (`section.purpose.en`).
 */
export const importColumns = [
  "number",
  "revision",
  "type",
  "category",
  "area",
  "owner",
  "title",
  "approvedOn",
  "approvedBy",
  "lastReviewedOn",
  "effectiveOn",
  "nextReviewOn",
  "keptAt",
  "differences",
  "section",
  "reviewMonths",
  "confidentiality",
  "appliesTo",
  "roles",
  "keywords",
  "references",
  "acknowledge",
  "acknowledgeDays",
] as const;
export type ImportColumn = (typeof importColumns)[number];

/** The columns that hold one text per language. */
export const perLanguageColumns: readonly ImportColumn[] = [
  "title",
  "keptAt",
  "differences",
  "section",
];

/** Those a row must have filled in. */
export const requiredColumns: readonly ImportColumn[] = [
  "type",
  "category",
  "area",
  "owner",
  "title",
  "approvedOn",
  "approvedBy",
  "nextReviewOn",
  "keptAt",
  "section",
];

/** The columns that may hold several values, separated by `|`. */
export const listColumns: readonly ImportColumn[] = [
  "appliesTo",
  "roles",
  "keywords",
  "references",
];

/** A row of the file, as written there. */
export type RowFields = {
  number: string;
  revision: string;
  type: string;
  category: string;
  area: string;
  owner: string;
  approvedOn: string;
  approvedBy: string;
  lastReviewedOn: string;
  effectiveOn: string;
  nextReviewOn: string;
  reviewMonths: string;
  confidentiality: string;
  appliesTo: string[];
  roles: string[];
  keywords: string[];
  references: string[];
  acknowledge: string;
  acknowledgeDays: string;
  title: Localized;
  keptAt: Localized;
  differences: Localized;
  /** Per section key, per language. */
  sections: Record<string, Localized>;
};

export type FileRow = {
  /**
   * Where it is in the file: its row as a spreadsheet numbers it, the
   * column names being row 1 (CSV), or its place in the list, from 1 (JSON).
   */
  at: number;
  fields: RowFields;
};

export type FileProblem =
  | { problem: "empty" }
  | { problem: "unreadable" }
  | { problem: "notJson" }
  | { problem: "noHeader" }
  | { problem: "unknownColumns"; columns: string[] };

const blankFields = (): RowFields => ({
  number: "",
  revision: "",
  type: "",
  category: "",
  area: "",
  owner: "",
  approvedOn: "",
  approvedBy: "",
  lastReviewedOn: "",
  effectiveOn: "",
  nextReviewOn: "",
  reviewMonths: "",
  confidentiality: "",
  appliesTo: [],
  roles: [],
  keywords: [],
  references: [],
  acknowledge: "",
  acknowledgeDays: "",
  title: {},
  keptAt: {},
  differences: {},
  sections: {},
});

/** Text as typed: Windows line ends made plain, spaces at the ends taken off. */
const clean = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";

const splitList = (value: string) =>
  value
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Reads a CSV text: a header row, then a row per document. Fields are
 * separated by commas, or by semicolons when the header has semicolons and
 * no commas (as spreadsheets save it in some languages); a field in double
 * quotes may hold separators, line ends and doubled quotes.
 */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const separator =
    firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === separator) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A column name the file uses, read: its field, language and section. */
type Localizable = "title" | "keptAt" | "differences";
type ColumnRef =
  | { column: Exclude<ImportColumn, Localizable | "section"> }
  | { column: Localizable; locale: string }
  | { column: "section"; key: string; locale: string };

function readColumnName(name: string): ColumnRef | null {
  const parts = name.trim().split(".");
  const [head] = parts;
  if (head === "section" && parts.length === 3 && parts[1] && parts[2]) {
    return { column: "section", key: parts[1], locale: parts[2] };
  }
  if (
    (head === "title" || head === "keptAt" || head === "differences") &&
    parts.length === 2 &&
    parts[1]
  ) {
    return { column: head, locale: parts[1] };
  }
  if (
    parts.length === 1 &&
    (importColumns as readonly string[]).includes(head) &&
    !perLanguageColumns.includes(head as ImportColumn)
  ) {
    return {
      column: head as Exclude<ImportColumn, Localizable | "section">,
    };
  }
  return null;
}

function put(fields: RowFields, ref: ColumnRef, value: string) {
  if (ref.column === "section") {
    if (!value) return;
    fields.sections[ref.key] = { ...fields.sections[ref.key], [ref.locale]: value };
  } else if (
    ref.column === "title" ||
    ref.column === "keptAt" ||
    ref.column === "differences"
  ) {
    if (value) fields[ref.column] = { ...fields[ref.column], [ref.locale]: value };
  } else {
    Object.assign(fields, {
      [ref.column]: listColumns.includes(ref.column) ? splitList(value) : value,
    });
  }
}

function fromCsv(text: string): FileRow[] | FileProblem {
  const table = parseCsv(text);
  const header = table[0];
  if (!header || header.every((h) => !h.trim())) return { problem: "noHeader" };
  const refs = header.map((h) => (h.trim() ? readColumnName(h) : null));
  const unknown = header.filter((h, i) => h.trim() && !refs[i]);
  if (unknown.length > 0) {
    return { problem: "unknownColumns", columns: unknown.map((h) => h.trim()) };
  }
  if (!refs.some((r) => r?.column === "type")) return { problem: "noHeader" };
  const rows: FileRow[] = [];
  for (const [i, cells] of table.slice(1).entries()) {
    // As a spreadsheet numbers it: the column names are row 1.
    const at = i + 2;
    if (cells.every((c) => !c.trim())) continue;
    const fields = blankFields();
    cells.forEach((cell, i) => {
      const ref = refs[i];
      if (ref) put(fields, ref, clean(cell));
    });
    rows.push({ at, fields });
  }
  return rows;
}

const asLocalized = (value: unknown): Localized =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([k, v]) => [k, clean(v)])
          .filter(([, v]) => v),
      )
    : {};

const asList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(clean).filter(Boolean)
    : typeof value === "string"
      ? splitList(value)
      : [];

function fromJson(text: string): FileRow[] | FileProblem {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { problem: "notJson" };
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { documents?: unknown }).documents)
      ? (data as { documents: unknown[] }).documents
      : null;
  if (!list) return { problem: "notJson" };
  const known = new Set<string>([...importColumns, "sections"]);
  const unknown = new Set<string>();
  const rows = list.map((item, i): FileRow => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!known.has(k)) unknown.add(k);
    const fields = blankFields();
    for (const column of importColumns) {
      if (column === "title" || column === "keptAt" || column === "differences")
        fields[column] = asLocalized(o[column]);
      else if (column === "section") continue;
      else
        Object.assign(fields, {
          [column]: listColumns.includes(column) ? asList(o[column]) : clean(o[column]),
        });
    }
    const sections = (o.sections ?? o.section) as unknown;
    if (sections && typeof sections === "object" && !Array.isArray(sections)) {
      for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
        const text = asLocalized(value);
        if (Object.keys(text).length > 0) fields.sections[key] = text;
      }
    }
    return { at: i + 1, fields };
  });
  if (unknown.size > 0) return { problem: "unknownColumns", columns: [...unknown] };
  return rows;
}

/** Reads a file of documents to import: JSON if it looks like JSON, else CSV. */
export function readImportFile(
  text: string,
): { kind: "csv" | "json"; rows: FileRow[] } | FileProblem {
  const body = text.replace(/^\uFEFF/, "").trim();
  if (!body) return { problem: "empty" };
  const kind = body.startsWith("[") || body.startsWith("{") ? "json" : "csv";
  const rows = kind === "json" ? fromJson(body) : fromCsv(body);
  if (!Array.isArray(rows)) return rows;
  if (rows.length === 0) return { problem: "empty" };
  return { kind, rows };
}

// From the file's codes and names to the ids the API takes.

export type ImportLists = {
  types: DocumentType[];
  categories: DocumentCategory[];
  units: OrgUnit[];
  /** Null when they could not be read. */
  roles: PolicyRole[] | null;
};

/** What could not be turned into an id: the field, and why. */
export type LocalProblem = {
  field: "type" | "category" | "area" | "owner" | "appliesTo" | "roles";
  why: "missing" | "unknown" | "ambiguous";
  /** The value that was not found. */
  value?: string;
};

const same = (a: string, b: string) =>
  a.trim().replace(/\s+/g, " ").toLocaleLowerCase() ===
  b.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** A type by its code, or by the prefix of its numbers. */
export const findType = (lists: ImportLists, value: string) =>
  lists.types.find((t) => same(t.code, value)) ??
  lists.types.find((t) => same(t.numberPrefix, value));

export const findCategory = (lists: ImportLists, value: string) =>
  lists.categories.find((c) => same(c.code, value));

export const findUnit = (lists: ImportLists, value: string) =>
  lists.units.find((u) => same(u.code, value));

/** People whose name, in any language, is the one written. */
export const peopleNamed = (people: Person[], name: string) =>
  people.filter((p) => Object.values(p.name).some((n) => n && same(n, name)));

// As the layout gives them; anything else goes to the API, which refuses it.
const yes = ["yes", "true", "1"];
const no = ["no", "false", "0", ""];

/**
 * A row as the API takes it, with what could not be found. `ownerId` is
 * the owner chosen for it, when the name in the file named no one or
 * several people.
 */
export function toImportDocument(
  fields: RowFields,
  lists: ImportLists,
  owners: { id: string | null; candidates: Person[] },
): { body: ImportDocument | null; problems: LocalProblem[] } {
  const problems: LocalProblem[] = [];
  const need = <T,>(
    field: LocalProblem["field"],
    value: string,
    find: (v: string) => T | undefined,
  ) => {
    if (!value) {
      problems.push({ field, why: "missing" });
      return undefined;
    }
    const found = find(value);
    if (!found) problems.push({ field, why: "unknown", value });
    return found;
  };
  const type = need("type", fields.type, (v) => findType(lists, v));
  const category = need("category", fields.category, (v) => findCategory(lists, v));
  const unit = need("area", fields.area, (v) => findUnit(lists, v));
  let ownerId = owners.id;
  if (!ownerId) {
    if (!fields.owner) problems.push({ field: "owner", why: "missing" });
    else if (owners.candidates.length === 0)
      problems.push({ field: "owner", why: "unknown", value: fields.owner });
    else if (owners.candidates.length > 1)
      problems.push({ field: "owner", why: "ambiguous", value: fields.owner });
    else ownerId = owners.candidates[0].id;
  }
  const audienceUnits = fields.appliesTo.map((code) => {
    const found = findUnit(lists, code);
    if (!found) problems.push({ field: "appliesTo", why: "unknown", value: code });
    return found?.id ?? "";
  });
  const roleIds = fields.roles.map((code) => {
    const found = lists.roles?.find((r) => same(r.code, code));
    if (!found) problems.push({ field: "roles", why: "unknown", value: code });
    return found?.id ?? "";
  });
  if (problems.length > 0 || !type || !category || !unit || !ownerId) {
    return { body: null, problems };
  }
  const content: Record<string, Record<string, string>> = {};
  for (const [key, text] of Object.entries(fields.sections)) {
    for (const [locale, value] of Object.entries(text)) {
      if (value) content[locale] = { ...content[locale], [key]: value };
    }
  }
  const number = (value: string) =>
    /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  const ack = fields.acknowledge.trim().toLocaleLowerCase();
  const acknowledgementRequired = yes.includes(ack)
    ? true
    : no.includes(ack)
      ? false
      : fields.acknowledge;
  const body: ImportDocument = {
    typeId: type.id,
    categoryId: category.id,
    title: fields.title,
    ownerId,
    ownerUnitId: unit.id,
    audience: { orgUnitIds: audienceUnits, roleIds },
    confidentiality: fields.confidentiality || "all_staff",
    keywords: fields.keywords,
    references: fields.references,
    approvedOn: fields.approvedOn,
    approvedBy: fields.approvedBy,
    originalKeptAt: fields.keptAt,
    nextReviewOn: fields.nextReviewOn,
    content,
    acknowledgementRequired,
  };
  if (fields.number) body.number = fields.number;
  if (fields.revision) body.revisionLabel = fields.revision;
  if (fields.effectiveOn) body.effectiveOn = fields.effectiveOn;
  if (fields.lastReviewedOn) body.lastReviewedOn = fields.lastReviewedOn;
  if (Object.keys(fields.differences).length > 0) body.differences = fields.differences;
  if (fields.reviewMonths) body.reviewMonths = number(fields.reviewMonths);
  if (fields.acknowledgeDays && acknowledgementRequired === true) {
    body.acknowledgeWithinDays = number(fields.acknowledgeDays);
  }
  return { body, problems };
}

/**
 * The file's column a field the API names belongs to, for a document the
 * API found malformed (`invalid_document` names its fields).
 */
export function columnOfField(field: string): ImportColumn | null {
  const head = field.split(".")[0];
  const map: Record<string, ImportColumn> = {
    typeId: "type",
    categoryId: "category",
    ownerUnitId: "area",
    ownerId: "owner",
    title: "title",
    number: "number",
    revisionLabel: "revision",
    approvedOn: "approvedOn",
    approvedBy: "approvedBy",
    lastReviewedOn: "lastReviewedOn",
    differences: "differences",
    effectiveOn: "effectiveOn",
    nextReviewOn: "nextReviewOn",
    originalKeptAt: "keptAt",
    content: "section",
    reviewMonths: "reviewMonths",
    confidentiality: "confidentiality",
    keywords: "keywords",
    references: "references",
    acknowledgementRequired: "acknowledge",
    acknowledgeWithinDays: "acknowledgeDays",
  };
  if (head === "audience") {
    return field.includes("roleIds") ? "roles" : "appliesTo";
  }
  return map[head] ?? null;
}

/** Characters of text a document carries, as the API counts them. */
export const textSize = (doc: ImportDocument) =>
  Object.values(doc.content).reduce(
    (n, sections) =>
      n + Object.values(sections).reduce((m, text) => m + text.length, 0),
    0,
  );

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Cuts the documents, in their order, into batches the API accepts: at
 * most 20 documents and 600,000 characters of text each, and a request
 * under its size limit. Each batch is signed on its own.
 */
export function splitIntoBatches<T>(
  items: T[],
  bodyOf: (item: T) => ImportDocument,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let characters = 0;
  let size = bytes({ password: "x".repeat(1024), documents: [] });
  for (const item of items) {
    const body = bodyOf(item);
    const chars = textSize(body);
    const more = bytes(body) + 1;
    if (
      current.length > 0 &&
      (current.length >= IMPORT_MAX_DOCUMENTS ||
        characters + chars > IMPORT_MAX_CHARACTERS ||
        size + more > IMPORT_BODY_BUDGET)
    ) {
      batches.push(current);
      current = [];
      characters = 0;
      size = bytes({ password: "x".repeat(1024), documents: [] });
    }
    current.push(item);
    characters += chars;
    size += more;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// The example file.

/** The example's words, in one language, from that language's dictionary. */
export type ExampleWords = {
  /** Two of each, one per example document. */
  titles: string[];
  keptAt: string[];
  approvedBy: string[];
  revision: string;
  section: string;
  keywords: string;
  /** What the first example does not reproduce of its original. */
  differences: string;
};

export type ExampleRow = Record<string, string>;

const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Two example documents, in the client's own codes and languages: one
 * keeping the number its original gives, one numbered by Trustline and
 * asking for acknowledgement. Each language's text from its dictionary.
 */
export function exampleRows(input: {
  lists: ImportLists;
  locales: string[];
  defaultLocale: string;
  owner: string;
  today: string;
  words: Record<string, ExampleWords>;
}): { columns: string[]; rows: ExampleRow[] } {
  const { lists, locales, defaultLocale, owner, today, words } = input;
  const type = lists.types[0];
  const category = lists.categories[0];
  const unit = lists.units.find((u) => u.active) ?? lists.units[0];
  const inLocale = (l: string) => words[l] ?? words[defaultLocale] ?? Object.values(words)[0];
  const main = inLocale(defaultLocale);
  const sections = (type?.sections ?? []).filter((s) => s.required).slice(0, 2);
  const columns = [
    "number",
    "revision",
    "type",
    "category",
    "area",
    "owner",
    ...locales.map((l) => `title.${l}`),
    "approvedOn",
    "approvedBy",
    "lastReviewedOn",
    "effectiveOn",
    "nextReviewOn",
    ...locales.map((l) => `keptAt.${l}`),
    ...locales.map((l) => `differences.${l}`),
    ...sections.flatMap((s) => locales.map((l) => `section.${s.key}.${l}`)),
    "confidentiality",
    "appliesTo",
    "keywords",
    "acknowledge",
    "acknowledgeDays",
  ];
  const approvedOn = addDays(today, -400);
  const rows = [0, 1].map((i): ExampleRow => {
    const row: ExampleRow = {
      number: i === 0 ? `${category?.code ?? "DOC"}-${String(4).padStart(2, "0")}` : "",
      revision: i === 0 ? main.revision : "",
      type: type?.code ?? "",
      category: category?.code ?? "",
      area: unit?.code ?? "",
      owner,
      approvedOn: addDays(approvedOn, i * 30),
      approvedBy: main.approvedBy[i] ?? "",
      // Reviewed on paper since its approval: the first only.
      lastReviewedOn: i === 0 ? addDays(approvedOn, 200) : "",
      effectiveOn: addDays(approvedOn, i * 30 + 14),
      nextReviewOn: addDays(today, 90 + i * 90),
      confidentiality: "all_staff",
      appliesTo: "",
      keywords: i === 0 ? main.keywords : "",
      acknowledge: i === 0 ? "no" : "yes",
      acknowledgeDays: i === 0 ? "" : "14",
    };
    for (const l of locales) {
      row[`title.${l}`] = inLocale(l).titles[i] ?? "";
      row[`keptAt.${l}`] = inLocale(l).keptAt[i] ?? "";
      row[`differences.${l}`] = i === 0 ? inLocale(l).differences : "";
      for (const s of sections) row[`section.${s.key}.${l}`] = inLocale(l).section;
    }
    return row;
  });
  return { columns, rows };
}

const csvCell = (value: string) =>
  /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** The example as a CSV file, with a byte-order mark for spreadsheets. */
export const exampleCsv = ({ columns, rows }: { columns: string[]; rows: ExampleRow[] }) =>
  `\uFEFF${[columns, ...rows.map((r) => columns.map((c) => r[c] ?? ""))]
    .map((cells) => cells.map(csvCell).join(","))
    .join("\r\n")}\r\n`;

/** The same documents as a JSON file. */
export function exampleJson({ rows }: { columns: string[]; rows: ExampleRow[] }) {
  const documents = rows.map((row) => {
    const out: Record<string, unknown> = {};
    const sections: Record<string, Localized> = {};
    for (const [name, value] of Object.entries(row)) {
      const parts = name.split(".");
      if (parts[0] === "section") {
        sections[parts[1]] = { ...sections[parts[1]], [parts[2]]: value };
      } else if (parts.length === 2) {
        if (value) out[parts[0]] = { ...(out[parts[0]] as object), [parts[1]]: value };
      } else if (name === "appliesTo" || name === "keywords") {
        out[name] = splitList(value);
      } else if (name === "acknowledge") {
        out[name] = value === "yes";
      } else if (name === "acknowledgeDays") {
        if (value) out[name] = Number(value);
      } else if (value) {
        out[name] = value;
      }
    }
    out.sections = sections;
    return out;
  });
  return `${JSON.stringify({ documents }, null, 2)}\n`;
}

/** Offers a text as a file to download. */
export function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
