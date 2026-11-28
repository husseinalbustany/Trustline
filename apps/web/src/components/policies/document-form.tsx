"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
} from "react";
import { canIn, useSession } from "@/components/shell/session";
import {
  ReadOnlyFieldset,
  useReadOnly,
} from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api, codeOf, statusOf } from "@/lib/api";
import { durationFormat, fill } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import { pick, readForm, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import {
  categoriesInOrder,
  documentPath,
  versionPath,
  type DocumentCategory,
  type DocumentType,
  type Named,
  type Person,
  type PolicyRole,
  type PolicySettings,
  type PolicyDocument,
} from "@/lib/policies";
import { textareaClass, type PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

export type Lists = {
  types: DocumentType[];
  categories: DocumentCategory[];
  units: OrgUnit[];
  people: Person[];
  /** Null when this person may not list the roles. */
  roles: PolicyRole[] | null;
  /** The organization's longest review period; null if it could not be read. */
  maxReviewMonths: number | null;
};

export async function loadLists(): Promise<Lists> {
  const [types, categories, units, people, roles, settings] =
    await Promise.all([
      api<DocumentType[]>("/policies/types"),
      api<DocumentCategory[]>("/policies/categories"),
      api<OrgUnit[]>("/org-units"),
      api<Person[]>("/policies/people").catch(() => []),
      api<PolicyRole[]>("/policies/roles").catch(() => null),
      api<PolicySettings>("/policies/settings").catch(() => null),
    ]);
  return {
    types,
    categories,
    units,
    people,
    roles,
    maxReviewMonths: settings?.maxReviewMonths ?? null,
  };
}

/** A new document: its details, then its first version in the editor. */
export function NewDocument({ lang, t }: PoliciesProps) {
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState(false);
  useEffect(() => {
    let current = true;
    loadLists()
      .then((l) => current && setLists(l))
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, []);
  return (
    <>
      <PageHeader title={t.form.newTitle} description={t.form.newDescription} />
      {problem ? (
        <EmptyState>{t.loadError}</EmptyState>
      ) : !lists ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <DocumentForm lang={lang} t={t} lists={lists} doc={null} />
      )}
    </>
  );
}

/** A document's details, edited directly (they are not part of a version). */
export function EditDocument({ lang, t }: PoliciesProps) {
  const { id } = useParams<{ id: string }>();
  const [loaded, setLoaded] = useState<{ doc: PolicyDocument; lists: Lists } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    Promise.all([api<PolicyDocument>(`/policies/documents/${id}`), loadLists()])
      .then(([doc, lists]) => {
        if (!current) return;
        setLoaded({ doc, lists });
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 404 ? t.notFound : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [id, t]);
  const shown = loaded?.doc.id === id ? loaded : null;
  if (problem || !shown) return <EmptyState>{problem ?? t.loading}</EmptyState>;
  if (!shown.doc.moves.includes("edit")) {
    return (
      <>
        <EmptyState>{t.form.notEditable}</EmptyState>
        <p className="text-center text-sm">
          <Link
            href={documentPath(lang, shown.doc.id)}
            className="text-accent hover:underline"
          >
            {t.review.backToDocument}
          </Link>
        </p>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={t.form.editTitle}
        description={
          <bdi dir="ltr" className="whitespace-nowrap">
            {shown.doc.number}
          </bdi>
        }
      />
      <DocumentForm
        key={`${shown.doc.id}:${shown.doc.revision}`}
        lang={lang}
        t={t}
        lists={shown.lists}
        doc={shown.doc}
      />
    </>
  );
}

function DocumentForm({
  lang,
  t,
  lists,
  doc,
}: PoliciesProps & { lists: Lists; doc: PolicyDocument | null }) {
  const router = useRouter();
  const readOnly = useReadOnly();
  const explainError = useExplain(t, lang);
  const f = t.form;
  const [typeId, setTypeId] = useState(doc?.type.id ?? "");
  const [whole, setWhole] = useState(doc ? doc.audience.wholeOrganization : true);
  const [ackRequired, setAckRequired] = useState(false);
  // A change of review period is kept with its reason.
  const [periodChanged, setPeriodChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const body = readDocumentBody(form, whole);
    const months = String(data.get("reviewMonths") ?? "").trim();
    if (!body) return setError(f.audienceUnitsMissing);
    setBusy(true);
    setError(null);
    try {
      if (!doc) {
        const days = Number(data.get("acknowledgeWithinDays") ?? 14);
        const created = await api<PolicyDocument>("/policies/documents", {
          method: "POST",
          body: {
            ...body,
            typeId,
            acknowledgementRequired: ackRequired,
            ...(ackRequired ? { acknowledgeWithinDays: days } : {}),
          },
        });
        // Visited pages stay mounted: the next new document starts empty.
        form.reset();
        setTypeId("");
        setWhole(true);
        setAckRequired(false);
        router.push(
          created.inProgress
            ? `${versionPath(lang, created.id, created.inProgress.id)}/edit`
            : documentPath(lang, created.id),
        );
        return;
      }
      if (!months) body.reviewMonths = doc.reviewMonths;
      const reason = String(data.get("reason") ?? "").trim();
      if (periodChanged && reason) body.reason = reason;
      const saved = await api<PolicyDocument | { id: string; moved: true }>(
        `/policies/documents/${doc.id}`,
        { method: "PATCH", body: { ...body, revision: doc.revision } },
      );
      router.push(
        "moved" in saved ? `/${lang}/policies` : documentPath(lang, doc.id),
      );
      return;
    } catch (err) {
      const code = codeOf(err);
      // A refusal of this module the dictionary has no words for yet,
      // about a version in progress: said in general terms.
      setError(
        statusOf(err) === 409 && code && !Object.hasOwn(t.errors, code)
          ? t.errors.locked_while_in_progress
          : explainError(err),
      );
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-6 flex max-w-3xl flex-col gap-6">
      <ReadOnlyFieldset>
        <DocumentFields
          lang={lang}
          t={t}
          lists={lists}
          doc={doc}
          typeId={typeId}
          onTypeChange={setTypeId}
          whole={whole}
          onWholeChange={setWhole}
          acknowledgement={
            doc ? null : { required: ackRequired, onChange: setAckRequired }
          }
          onPeriodChange={setPeriodChanged}
          periodChanged={periodChanged}
        />
      </ReadOnlyFieldset>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || readOnly}>
          {doc ? f.save : f.create}
        </Button>
        <Link
          href={doc ? documentPath(lang, doc.id) : `/${lang}/policies`}
          className="text-sm text-accent hover:underline"
        >
          {t.actions.cancel}
        </Link>
      </div>
    </form>
  );
}

/**
 * A document's details as a form reads them, for creating, editing or
 * importing it; null when "some areas only" is chosen with none ticked.
 */
export function readDocumentBody(
  form: HTMLFormElement,
  whole: boolean,
): Record<string, unknown> | null {
  const data = new FormData(form);
  const fields = readForm(form);
  const list = (name: string, split: RegExp) =>
    String(data.get(name) ?? "")
      .split(split)
      .map((s) => s.trim())
      .filter(Boolean);
  const months = String(data.get("reviewMonths") ?? "").trim();
  const orgUnitIds = whole ? [] : data.getAll("audienceUnit").map(String);
  if (!whole && orgUnitIds.length === 0) return null;
  const body: Record<string, unknown> = {
    title: fields.title,
    ownerId: data.get("ownerId"),
    ownerUnitId: data.get("ownerUnitId"),
    categoryId: data.get("categoryId"),
    confidentiality: data.get("confidentiality"),
    audience: {
      orgUnitIds,
      roleIds: data.getAll("audienceRole").map(String),
    },
    keywords: list("keywords", /[,،]/),
    references: list("references", /\n/),
  };
  if (months) body.reviewMonths = Number(months);
  return body;
}

/**
 * The panels of a document's details: what it is, who is responsible, who
 * it applies to, its review and what helps find it. For a new document
 * (or an imported one) also whether its readers are asked to acknowledge
 * it.
 */
export function DocumentFields({
  lang,
  t,
  lists,
  doc,
  typeId,
  onTypeChange,
  whole,
  onWholeChange,
  acknowledgement,
  periodChanged = false,
  onPeriodChange,
  reviewMonthsHelp,
}: PoliciesProps & {
  lists: Lists;
  doc: PolicyDocument | null;
  typeId: string;
  onTypeChange: (id: string) => void;
  whole: boolean;
  onWholeChange: (whole: boolean) => void;
  /** Null when it is not asked here. */
  acknowledgement: { required: boolean; onChange: (on: boolean) => void } | null;
  periodChanged?: boolean;
  onPeriodChange?: (changed: boolean) => void;
  /** Said under the review period instead of the usual help. */
  reviewMonthsHelp?: string;
}) {
  const session = useSession();
  const f = t.form;
  const { defaultLocale, locales } = session.tenant;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, defaultLocale);
  const ackRequired = acknowledgement?.required ?? false;
  const maxMonths = Math.max(
    lists.maxReviewMonths ?? 120,
    // A period set longer before the maximum stays until it changes.
    doc?.reviewMonths ?? 0,
  );
  const [people, setPeople] = useState<Person[]>(lists.people);
  const type = lists.types.find((x) => x.id === typeId);
  // Units this person manages documents for: a document is owned there.
  const owningUnits = unitOptions(
    lists.units.filter((u) => canIn(session, "policies.manage", u.id)),
    (u) => inLang(u.name),
    doc ? { id: doc.ownerUnit.id, label: inLang(doc.ownerUnit.name) } : null,
  );
  const audienceUnits = unitOptions(lists.units, (u) => inLang(u.name), null);
  const chosenUnits = new Set(doc?.audience.orgUnits.map((u) => u.id) ?? []);
  const chosenRoles = new Set(doc?.audience.roles.map((r) => r.id) ?? []);
  // A role already on the document stays listed even when the roles
  // cannot be read by this person.
  const roles: Named[] = lists.roles
    ? lists.roles.map((r) => ({ id: r.id, name: r.name }))
    : (doc?.audience.roles ?? []);
  // The owner stays offered, whoever they are.
  const owners = [...people];
  if (doc && !owners.some((p) => p.id === doc.owner.id)) {
    owners.unshift({ id: doc.owner.id, name: doc.owner.name ?? {}, orgUnitId: null });
  }
  if (!doc && !owners.some((p) => p.id === session.user.id)) {
    owners.unshift({ id: session.user.id, name: session.user.name, orgUnitId: session.user.orgUnitId });
  }

  async function findPeople(q: string) {
    try {
      setPeople(
        await api<Person[]>(
          `/policies/people${q.trim() ? `?${new URLSearchParams({ q: q.trim() })}` : ""}`,
        ),
      );
    } catch {
      // The list shown stays as it was.
    }
  }

  const radioRow = "flex items-start gap-3 rounded-md border border-line p-3 text-sm";

  return (
    <>
        <Panel title={f.what}>
          <div className="flex flex-col gap-5 p-4">
            {doc ? (
              <p className="text-sm">
                <span className="text-muted">{f.type}: </span>
                <bdi>{inLang(doc.type.name)}</bdi>
                <span className="block text-xs text-muted">{f.typeFixed}</span>
              </p>
            ) : (
              <Field label={f.type} help={f.typeHelp}>
                <select
                  name="typeId"
                  required
                  value={typeId}
                  onChange={(e) => onTypeChange(e.target.value)}
                  className={inputClass}
                >
                  <option value="" disabled>
                    {f.choose}
                  </option>
                  {lists.types.map((x) => (
                    <option key={x.id} value={x.id}>
                      {inLang(x.name)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={f.category} help={doc ? f.categoryNumberHelp : f.categoryHelp}>
              <select
                name="categoryId"
                required
                defaultValue={doc?.category.id ?? ""}
                className={inputClass}
              >
                <option value="" disabled>
                  {f.choose}
                </option>
                {categoriesInOrder(lists.categories).map(({ category, depth }) => (
                  <option key={category.id} value={category.id}>
                    {`${"— ".repeat(depth)}${inLang(category.name)}`}
                  </option>
                ))}
              </select>
            </Field>
            <LocalizedField
              label={f.title}
              name="title"
              locales={locales}
              required={defaultLocale}
              value={doc?.title}
              maxLength={300}
            />
          </div>
        </Panel>

        <Panel title={f.who}>
          <div className="flex flex-col gap-5 p-4">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={f.ownerSearch} help={f.ownerSearchHelp}>
                <input
                  type="search"
                  dir="auto"
                  maxLength={100}
                  autoComplete="off"
                  onChange={(e) => void findPeople(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label={f.owner} help={f.ownerHelp}>
                <select
                  name="ownerId"
                  required
                  defaultValue={doc?.owner.id ?? session.user.id}
                  className={inputClass}
                >
                  {owners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {inLang(p.name)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={f.ownerUnit} help={f.ownerUnitHelp}>
              <select
                name="ownerUnitId"
                required
                defaultValue={doc?.ownerUnit.id ?? ""}
                className={inputClass}
              >
                <option value="" disabled>
                  {f.choose}
                </option>
                {owningUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Panel>

        <Panel title={f.audience}>
          <div className="flex flex-col gap-4 p-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{f.appliesTo}</legend>
              <label className={radioRow}>
                <input
                  type="radio"
                  checked={whole}
                  onChange={() => onWholeChange(true)}
                  className="mt-0.5 accent-accent"
                />
                {f.wholeOrganization}
              </label>
              <label className={radioRow}>
                <input
                  type="radio"
                  checked={!whole}
                  onChange={() => onWholeChange(false)}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  {f.someUnits}
                  <span className="block text-xs text-muted">{f.someUnitsHelp}</span>
                </span>
              </label>
            </fieldset>
            {!whole && (
              <fieldset className="grid gap-1 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium">{f.units}</legend>
                {audienceUnits.map((u) => (
                  <label key={u.id} className="flex min-h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="audienceUnit"
                      value={u.id}
                      defaultChecked={chosenUnits.has(u.id)}
                      className="size-4 accent-accent"
                    />
                    {u.label}
                  </label>
                ))}
              </fieldset>
            )}
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-medium">{f.roles}</legend>
              <p className="mb-1 text-xs text-muted">{f.rolesHelp}</p>
              {roles.length === 0 ? (
                <p className="text-xs text-muted">
                  {lists.roles ? f.noRoles : f.rolesUnavailable}
                </p>
              ) : (
                <div className="grid gap-1 sm:grid-cols-2">
                  {roles.map((r) => (
                    <label key={r.id} className="flex min-h-9 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="audienceRole"
                        value={r.id}
                        defaultChecked={chosenRoles.has(r.id)}
                        className="size-4 accent-accent"
                      />
                      <bdi>{inLang(r.name)}</bdi>
                    </label>
                  ))}
                </div>
              )}
              {!lists.roles && roles.length > 0 && (
                <p className="text-xs text-muted">{f.rolesUnavailable}</p>
              )}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{f.confidentiality}</legend>
              {(["all_staff", "restricted"] as const).map((value) => (
                <label key={value} className={radioRow}>
                  <input
                    type="radio"
                    name="confidentiality"
                    value={value}
                    defaultChecked={(doc?.confidentiality ?? "all_staff") === value}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    {t.confidentiality[value]}
                    <span className="block text-xs text-muted">
                      {t.confidentialityHelp[value]}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        </Panel>

        <Panel title={f.more}>
          <div className="flex flex-col gap-5 p-4">
            <div className="max-w-56">
              <Field
                label={f.reviewMonths}
                help={
                  reviewMonthsHelp ??
                  [
                    type
                      ? fill(f.reviewMonthsHelp, { months: durationFormat(lang)(type.defaultReviewMonths, "month") })
                      : f.reviewMonthsHelpNoType,
                    lists.maxReviewMonths
                      ? fill(f.reviewMonthsMax, {
                          months: durationFormat(lang)(lists.maxReviewMonths, "month"),
                        })
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
              >
                <input
                  name="reviewMonths"
                  type="number"
                  min={1}
                  max={maxMonths}
                  onChange={(e) =>
                    onPeriodChange?.(
                      !!doc &&
                        e.target.value !== "" &&
                        Number(e.target.value) !== doc.reviewMonths,
                    )
                  }
                  inputMode="numeric"
                  dir="ltr"
                  defaultValue={doc ? String(doc.reviewMonths) : ""}
                  required={!!doc}
                  className={inputClass}
                />
              </Field>
            </div>
            {periodChanged && (
              <Field label={f.reason} help={f.reasonHelp}>
                <textarea
                  name="reason"
                  required
                  rows={2}
                  maxLength={1000}
                  dir="auto"
                  className={textareaClass}
                />
              </Field>
            )}
            <Field label={f.keywords} help={f.keywordsHelp}>
              <input
                name="keywords"
                dir="auto"
                maxLength={2000}
                defaultValue={doc?.keywords.join(", ") ?? ""}
                className={inputClass}
              />
            </Field>
            <Field label={f.references} help={f.referencesHelp}>
              <textarea
                name="references"
                rows={3}
                dir="auto"
                defaultValue={doc?.references.join("\n") ?? ""}
                className={textareaClass}
              />
            </Field>
            {acknowledgement && (
              <>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={ackRequired}
                    onChange={(e) => acknowledgement.onChange(e.target.checked)}
                    className="mt-0.5 size-4 accent-accent"
                  />
                  <span>
                    <span className="font-medium">{t.editor.ackRequired}</span>
                    <span className="block text-xs text-muted">{t.editor.ackRequiredHelp}</span>
                  </span>
                </label>
                {ackRequired && (
                  <div className="max-w-56">
                    <Field label={t.editor.ackDays}>
                      <input
                        name="acknowledgeWithinDays"
                        type="number"
                        min={1}
                        max={365}
                        defaultValue="14"
                        inputMode="numeric"
                        dir="ltr"
                        className={inputClass}
                      />
                    </Field>
                  </div>
                )}
              </>
            )}
          </div>
        </Panel>
    </>
  );
}
