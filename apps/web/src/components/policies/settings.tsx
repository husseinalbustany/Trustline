"use client";

import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useSession } from "@/components/shell/session";
import {
  ReadOnlyFieldset,
  useReadOnly,
} from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { direction, hasLocale, localeNames } from "@/i18n/config";
import { api, codeOf, detailsOf } from "@/lib/api";
import {
  durationFormat,
  fill,
  languageNameIn,
  numberFormat,
} from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  categoriesInOrder,
  type ApprovalRoute,
  type DocumentCategory,
  type DocumentType,
  type Named,
  type Person,
  type PolicyRole,
  type PolicySettings as OrganizationSettings,
  type StepKind,
} from "@/lib/policies";
import type { PoliciesProps, PoliciesText } from "./types";
import { useExplain } from "./use-explain";

const tabs = ["types", "categories", "routes", "general"] as const;
type Tab = (typeof tabs)[number];

type Lists = {
  types: DocumentType[];
  categories: DocumentCategory[];
  routes: ApprovalRoute[];
  roles: PolicyRole[] | null;
  approvers: Person[];
  settings: OrganizationSettings | null;
};

async function loadLists(): Promise<Lists> {
  const [types, categories, routes, roles, approvers, settings] =
    await Promise.all([
      api<DocumentType[]>("/policies/types?includeInactive=true"),
      api<DocumentCategory[]>("/policies/categories?includeInactive=true"),
      api<ApprovalRoute[]>("/policies/approval-routes"),
      api<PolicyRole[]>("/policies/roles").catch(() => null),
      api<Person[]>("/policies/people?approvers=true").catch(() => []),
      api<OrganizationSettings>("/policies/settings").catch(() => null),
    ]);
  return { types, categories, routes, roles, approvers, settings };
}

const languageName = (locale: string) =>
  hasLocale(locale) ? localeNames[locale] : locale;

/**
 * The module's settings, which belong to the whole organization: document
 * types (their sections, number prefix and review period), categories,
 * and approval routes. Nothing is deleted: a type, category or route is
 * switched off.
 */
export function PolicySettings({ lang, t }: PoliciesProps) {
  const session = useSession();
  const asked = useSearchParams().get("tab");
  const tab: Tab = tabs.find((x) => x === asked) ?? "types";
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState(false);
  const everywhere = session.scope?.["policies.manage"] === "all";
  const s = t.settings;

  const reload = useCallback(
    () =>
      loadLists()
        .then((l) => {
          setLists(l);
          setProblem(false);
        })
        .catch(() => setProblem(true)),
    [],
  );
  useEffect(() => {
    if (!everywhere) return;
    let current = true;
    loadLists()
      .then((l) => {
        if (!current) return;
        setLists(l);
        setProblem(false);
      })
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, [everywhere]);

  const chip = (on: boolean) =>
    `inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap ${
      on
        ? "border-accent bg-accent-soft font-medium text-accent"
        : "border-line text-muted hover:bg-surface hover:text-foreground"
    }`;

  return (
    <>
      <PageHeader title={s.title} description={s.description} />
      {!everywhere ? (
        <EmptyState>{s.noAccess}</EmptyState>
      ) : (
        <>
          <div role="group" aria-label={s.tabsLabel} className="mt-6 flex flex-wrap gap-2">
            {tabs.map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={tab === x}
                onClick={() =>
                  window.history.replaceState(null, "", `?tab=${x}`)
                }
                className={chip(tab === x)}
              >
                {s.tabs[x]}
              </button>
            ))}
          </div>
          <div className="mt-6">
            {problem ? (
              <EmptyState>{t.loadError}</EmptyState>
            ) : !lists ? (
              <EmptyState>{t.loading}</EmptyState>
            ) : tab === "types" ? (
              <Types lang={lang} t={t} lists={lists} reload={reload} />
            ) : tab === "categories" ? (
              <Categories lang={lang} t={t} lists={lists} reload={reload} />
            ) : tab === "routes" ? (
              <Routes lang={lang} t={t} lists={lists} reload={reload} />
            ) : (
              <General lang={lang} t={t} lists={lists} reload={reload} />
            )}
          </div>
        </>
      )}
    </>
  );
}

type PartProps = PoliciesProps & { lists: Lists; reload: () => Promise<void> };

/** One input per language of the client, held by the form that shows it. */
function NameInputs({
  label,
  value,
  onChange,
  maxLength = 120,
}: {
  label: string;
  value: Localized;
  onChange: (next: Localized) => void;
  maxLength?: number;
}) {
  const { locales, defaultLocale } = useSession().tenant;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {locales.map((locale) => (
        <Field
          key={locale}
          label={locales.length > 1 ? `${label} · ${languageName(locale)}` : label}
        >
          <input
            value={value[locale] ?? ""}
            onChange={(e) => onChange({ ...value, [locale]: e.target.value })}
            required={locale === defaultLocale}
            maxLength={maxLength}
            lang={locale}
            dir={direction(locale)}
            className={inputClass}
          />
        </Field>
      ))}
    </div>
  );
}

/** Only the client's languages, and none left blank. */
function kept(text: Localized, locales: string[]): Localized {
  return Object.fromEntries(
    locales
      .map((l) => [l, (text[l] ?? "").trim()])
      .filter(([, v]) => v !== ""),
  );
}

function useMessage() {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  useLayoutEffect(() => () => setMessage(null), []);
  const view: ReactNode = message && (
    <p
      role={message.ok ? "status" : "alert"}
      className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}
    >
      {message.text}
    </p>
  );
  return [view, setMessage] as const;
}

const iconButton =
  "inline-flex size-9 items-center justify-center rounded-md border border-line text-muted hover:bg-surface hover:text-foreground disabled:opacity-40";

// The organization's own settings.

/** The longest review period any type or document may set. */
function General({ lang, t, lists, reload }: PartProps) {
  const session = useSession();
  const explainError = useExplain(t, lang);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  // The types in the way, by their names, not their codes.
  const explain = (err: unknown) => {
    const over = detailsOf(err).types;
    if (codeOf(err) !== "type_exceeds_max" || !Array.isArray(over)) {
      return explainError(err);
    }
    const months = durationFormat(lang);
    return fill(t.errors.type_exceeds_max, {
      types: new Intl.ListFormat(lang, { type: "conjunction" }).format(
        (over as { id?: string; code?: string; defaultReviewMonths?: number }[]).map(
          (x) => {
            const type = lists.types.find((y) => y.id === x.id);
            const name = type ? inLang(type.name) : (x.code ?? "");
            return typeof x.defaultReviewMonths === "number"
              ? `${name} (${months(x.defaultReviewMonths, "month")})`
              : name;
          },
        ),
      ),
    });
  };
  const s = t.settings;
  const settings = lists.settings;
  const { locales, defaultLocale } = session.tenant;
  const [busy, setBusy] = useState(false);
  const [message, say] = useMessage();
  // The language chosen in the form, before it is saved: "" is the main one.
  const [chosen, setChosen] = useState<string | null>(null);
  // What a change of the language that applies did to versions in progress.
  const [effect, setEffect] = useState<string | null>(null);
  useLayoutEffect(() => () => setEffect(null), []);
  if (!settings) return <EmptyState>{t.loadError}</EmptyState>;
  const named = languageNameIn(lang);
  const numbers = numberFormat(lang);
  const current = settings.authoritativeLocale ?? "";
  const picked = chosen ?? current;
  const willApply = picked || defaultLocale;
  const changing = willApply !== settings.authoritative;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const months = Number(data.get("maxReviewMonths"));
    const language = String(data.get("authoritativeLocale") ?? "");
    setBusy(true);
    say(null);
    setEffect(null);
    try {
      const saved = await api<OrganizationSettings>("/policies/settings", {
        method: "PATCH",
        body: {
          maxReviewMonths: months,
          ...(locales.length > 1
            ? { authoritativeLocale: language || null }
            : {}),
          revision: settings!.revision,
        },
      });
      setChosen(null);
      await reload();
      say({ ok: true, text: s.saved });
      const v = saved.versionsInProgress;
      if (v) {
        setEffect(
          fill(s.authoritativeChanged, {
            language: named(saved.authoritative),
            draft: numbers.format(v.draft),
            inReview: numbers.format(v.in_review),
            approved: numbers.format(v.approved),
          }),
        );
      }
    } catch (err) {
      say({ ok: false, text: explain(err) });
    }
    setBusy(false);
  }

  return (
    <Panel title={s.tabs.general}>
      <form
        // Drawn again from what was saved, so the field shows it.
        key={settings.revision}
        onSubmit={submit}
        className="flex flex-col gap-4 p-4"
      >
        <ReadOnlyFieldset>
          <div className="max-w-xs">
            <Field label={s.maxReviewMonths} help={s.maxReviewMonthsHelp}>
              <input
                name="maxReviewMonths"
                type="number"
                min={1}
                max={120}
                required
                defaultValue={settings.maxReviewMonths}
                dir="ltr"
                inputMode="numeric"
                className={inputClass}
              />
            </Field>
          </div>
          {locales.length > 1 ? (
            <div className="flex max-w-xl flex-col gap-2">
              <div className="max-w-xs">
                <Field
                  label={s.authoritative}
                  help={fill(s.authoritativeHelp, {
                    language: named(settings.authoritative),
                  })}
                >
                  <select
                    name="authoritativeLocale"
                    value={picked}
                    onChange={(e) => setChosen(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">
                      {fill(s.authoritativeMain, {
                        language: named(defaultLocale),
                      })}
                    </option>
                    {locales.map((l) => (
                      <option key={l} value={l} lang={l}>
                        {languageName(l)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {changing && (
                <p
                  role="note"
                  className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm"
                >
                  {fill(s.authoritativeWillChange, {
                    from: named(settings.authoritative),
                    to: named(willApply),
                  })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">
              {fill(s.authoritativeOnly, { language: named(defaultLocale) })}
            </p>
          )}
          <div>
            <Button type="submit" disabled={busy}>
              {s.save}
            </Button>
          </div>
        </ReadOnlyFieldset>
        {message}
        {effect && (
          <p role="status" className="max-w-xl rounded-md bg-surface px-3 py-2 text-sm">
            {effect}
          </p>
        )}
      </form>
    </Panel>
  );
}

// Types.

type SectionDraft = {
  key: string;
  name: Localized;
  required: boolean;
  isNew: boolean;
};

function Types({ lang, t, lists, reload }: PartProps) {
  const session = useSession();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const s = t.settings;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  useLayoutEffect(() => () => setEditing(null), []);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{s.typesHelp}</p>
      <Panel>
        <ul>
          {lists.types.map((type) => (
            <li key={type.id} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    <bdi>{inLang(type.name)}</bdi>
                  </span>
                  <bdi dir="ltr" className="text-sm text-muted">
                    {type.numberPrefix}
                  </bdi>
                  {!type.active && <Pill tone="neutral">{s.inactive}</Pill>}
                </div>
                {editing !== type.id && (
                  <Button variant="secondary" onClick={() => setEditing(type.id)}>
                    {s.edit}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">
                {fill(s.typeLine, {
                  months: durationFormat(lang)(type.defaultReviewMonths, "month"),
                  sections: type.sections
                    .map((x) => inLang(x.name))
                    .join(" · "),
                })}
              </p>
              {editing === type.id && (
                <TypeForm
                  lang={lang}
                  t={t}
                  type={type}
                  maxMonths={lists.settings?.maxReviewMonths ?? 120}
                  onDone={async () => {
                    setEditing(null);
                    await reload();
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </li>
          ))}
        </ul>
      </Panel>
      {editing === "new" ? (
        <Panel title={s.newType}>
          <TypeForm
            lang={lang}
            t={t}
            type={null}
            maxMonths={lists.settings?.maxReviewMonths ?? 120}
            onDone={async () => {
              setEditing(null);
              await reload();
            }}
            onCancel={() => setEditing(null)}
          />
        </Panel>
      ) : (
        <ReadOnlyFieldset>
          <div>
            <Button variant="secondary" onClick={() => setEditing("new")}>
              <Plus className="size-4" aria-hidden />
              {s.addType}
            </Button>
          </div>
        </ReadOnlyFieldset>
      )}
    </div>
  );
}

function TypeForm({
  lang,
  t,
  type,
  maxMonths,
  onDone,
  onCancel,
}: PoliciesProps & {
  type: DocumentType | null;
  /** The organization's longest review period. */
  maxMonths: number;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const session = useSession();
  const { locales } = session.tenant;
  const readOnly = useReadOnly();
  const explainError = useExplain(t, lang);
  const s = t.settings;
  const [code, setCode] = useState("");
  const [name, setName] = useState<Localized>(type?.name ?? {});
  const [prefix, setPrefix] = useState(type?.numberPrefix ?? "");
  const [months, setMonths] = useState(String(type?.defaultReviewMonths ?? 24));
  const [active, setActive] = useState(type?.active ?? true);
  const [sections, setSections] = useState<SectionDraft[]>(
    type?.sections.map((x) => ({ ...x, isNew: false })) ?? [
      { key: "purpose", name: {}, required: true, isNew: true },
    ],
  );
  const [busy, setBusy] = useState(false);
  const [message, say] = useMessage();

  const change = (i: number, next: Partial<SectionDraft>) =>
    setSections((was) => was.map((x, j) => (j === i ? { ...x, ...next } : x)));
  const move = (i: number, by: -1 | 1) =>
    setSections((was) => {
      const next = [...was];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const keys = sections.map((x) => x.key.trim());
    if (new Set(keys).size !== keys.length) {
      return say({ ok: false, text: s.duplicateKey });
    }
    const body = {
      name: kept(name, locales),
      numberPrefix: prefix.trim().toUpperCase(),
      defaultReviewMonths: Number(months),
      sections: sections.map((x) => ({
        key: x.key.trim(),
        name: kept(x.name, locales),
        required: x.required,
      })),
    };
    setBusy(true);
    say(null);
    try {
      if (type) {
        await api(`/policies/types/${type.id}`, {
          method: "PATCH",
          body: { ...body, active, revision: type.revision },
        });
      } else {
        await api("/policies/types", {
          method: "POST",
          body: { ...body, code: code.trim() },
        });
      }
      await onDone();
    } catch (err) {
      say({ ok: false, text: explainError(err) });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-4 p-4">
      <ReadOnlyFieldset>
        {!type && (
          <Field label={s.code} help={s.codeHelp}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              pattern="[a-z][a-z0-9_]{1,39}"
              dir="ltr"
              autoCapitalize="none"
              className={inputClass}
            />
          </Field>
        )}
        <NameInputs label={s.name} value={name} onChange={setName} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={s.prefix} help={s.prefixHelp}>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              required
              pattern="[A-Za-z][A-Za-z0-9]{1,5}"
              maxLength={6}
              dir="ltr"
              autoCapitalize="characters"
              className={inputClass}
            />
          </Field>
          <Field label={s.reviewMonths} help={s.reviewMonthsHelp}>
            <input
              type="number"
              min={1}
              max={maxMonths}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
              required
              dir="ltr"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
        </div>
        {type && (
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="size-4 accent-accent"
            />
            {s.active}
          </label>
        )}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">{s.sections}</legend>
          <p className="text-xs text-muted">{s.sectionsHelp}</p>
          <ol className="flex flex-col gap-3">
            {sections.map((section, i) => (
              <li
                key={i}
                className="flex flex-col gap-3 rounded-md border border-line p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {fill(s.sectionNumber, { position: String(i + 1) })}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-label={s.moveUp}
                      title={s.moveUp}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      className={iconButton}
                    >
                      <ArrowUp className="size-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={s.moveDown}
                      title={s.moveDown}
                      disabled={i === sections.length - 1}
                      onClick={() => move(i, 1)}
                      className={iconButton}
                    >
                      <ArrowDown className="size-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={s.removeSection}
                      title={s.removeSection}
                      disabled={sections.length === 1}
                      onClick={() =>
                        setSections((was) => was.filter((_, j) => j !== i))
                      }
                      className={iconButton}
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </div>
                </div>
                {section.isNew ? (
                  <Field label={s.sectionKey} help={s.sectionKeyHelp}>
                    <input
                      value={section.key}
                      onChange={(e) => change(i, { key: e.target.value })}
                      required
                      pattern="[a-z][a-z0-9_]{1,39}"
                      dir="ltr"
                      autoCapitalize="none"
                      className={inputClass}
                    />
                  </Field>
                ) : (
                  <p className="text-xs text-muted">
                    {s.sectionKey}:{" "}
                    <bdi dir="ltr" className="font-mono">
                      {section.key}
                    </bdi>
                  </p>
                )}
                <NameInputs
                  label={s.sectionName}
                  value={section.name}
                  onChange={(next) => change(i, { name: next })}
                />
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={section.required}
                    onChange={(e) => change(i, { required: e.target.checked })}
                    className="size-4 accent-accent"
                  />
                  {s.sectionRequired}
                </label>
              </li>
            ))}
          </ol>
          <div>
            <Button
              variant="secondary"
              disabled={sections.length >= 30}
              onClick={() =>
                setSections((was) => [
                  ...was,
                  { key: "", name: {}, required: false, isNew: true },
                ])
              }
            >
              <Plus className="size-4" aria-hidden />
              {s.addSection}
            </Button>
          </div>
        </fieldset>
        {message}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || readOnly}>
            {type ? s.save : s.create}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t.actions.cancel}
          </Button>
        </div>
      </ReadOnlyFieldset>
    </form>
  );
}

// Categories.

function Categories({ lang, t, lists, reload }: PartProps) {
  const session = useSession();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const s = t.settings;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  useLayoutEffect(() => () => setEditing(null), []);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{s.categoriesHelp}</p>
      <Panel>
        <ul>
          {categoriesInOrder(lists.categories).map(({ category, depth }) => (
            <li
              key={category.id}
              className="border-b border-line px-4 py-3 last:border-b-0"
              style={{ paddingInlineStart: `${16 + depth * 20}px` }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <bdi className="font-medium">{inLang(category.name)}</bdi>
                  <bdi dir="ltr" className="text-sm text-muted">
                    {category.code}
                  </bdi>
                  {!category.active && <Pill tone="neutral">{s.inactive}</Pill>}
                </div>
                {editing !== category.id && (
                  <Button variant="secondary" onClick={() => setEditing(category.id)}>
                    {s.edit}
                  </Button>
                )}
              </div>
              {editing === category.id && (
                <CategoryForm
                  lang={lang}
                  t={t}
                  lists={lists}
                  category={category}
                  onDone={async () => {
                    setEditing(null);
                    await reload();
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </li>
          ))}
        </ul>
      </Panel>
      {editing === "new" ? (
        <Panel title={s.newCategory}>
          <CategoryForm
            lang={lang}
            t={t}
            lists={lists}
            category={null}
            onDone={async () => {
              setEditing(null);
              await reload();
            }}
            onCancel={() => setEditing(null)}
          />
        </Panel>
      ) : (
        <ReadOnlyFieldset>
          <div>
            <Button variant="secondary" onClick={() => setEditing("new")}>
              <Plus className="size-4" aria-hidden />
              {s.addCategory}
            </Button>
          </div>
        </ReadOnlyFieldset>
      )}
    </div>
  );
}

function CategoryForm({
  lang,
  t,
  lists,
  category,
  onDone,
  onCancel,
}: PoliciesProps & {
  lists: Lists;
  category: DocumentCategory | null;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const session = useSession();
  const { locales } = session.tenant;
  const readOnly = useReadOnly();
  const explainError = useExplain(t, lang);
  const s = t.settings;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const [code, setCode] = useState("");
  const [name, setName] = useState<Localized>(category?.name ?? {});
  const [parentId, setParentId] = useState(category?.parentId ?? "");
  const [active, setActive] = useState(category?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [message, say] = useMessage();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    say(null);
    const body = { name: kept(name, locales), parentId: parentId || null };
    try {
      if (category) {
        await api(`/policies/categories/${category.id}`, {
          method: "PATCH",
          body: { ...body, active, revision: category.revision },
        });
      } else {
        await api("/policies/categories", {
          method: "POST",
          body: { ...body, code: code.trim().toUpperCase() },
        });
      }
      await onDone();
    } catch (err) {
      say({ ok: false, text: explainError(err) });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-4 p-4">
      <ReadOnlyFieldset>
        {category ? (
          <p className="text-xs text-muted">{s.categoryCodeFixed}</p>
        ) : (
          <Field label={s.code} help={s.categoryCodeHelp}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              pattern="[A-Za-z][A-Za-z0-9]{1,5}"
              maxLength={6}
              dir="ltr"
              autoCapitalize="characters"
              className={inputClass}
            />
          </Field>
        )}
        <NameInputs label={s.name} value={name} onChange={setName} />
        <Field label={s.parent}>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className={inputClass}
          >
            <option value="">{s.noParent}</option>
            {categoriesInOrder(lists.categories)
              .filter(({ category: c }) => c.id !== category?.id)
              .map(({ category: c, depth }) => (
                <option key={c.id} value={c.id}>
                  {`${"— ".repeat(depth)}${inLang(c.name)}`}
                </option>
              ))}
          </select>
        </Field>
        {category && (
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="size-4 accent-accent"
            />
            {s.active}
          </label>
        )}
        {message}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || readOnly}>
            {category ? s.save : s.create}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t.actions.cancel}
          </Button>
        </div>
      </ReadOnlyFieldset>
    </form>
  );
}

// Approval routes.

type StepDraft = {
  kind: StepKind;
  by: "role" | "user";
  roleId: string;
  userId: string;
  dueInDays: string;
};

const assigneeLabel = (
  t: PoliciesText,
  inLang: (text: Localized | null | undefined) => string,
  assignee: ApprovalRoute["steps"][number]["assignee"],
) =>
  assignee.type === "role"
    ? fill(t.review.anyoneWithRole, { role: inLang(assignee.role.name) })
    : inLang(assignee.user?.name) || t.document.unknownPerson;

function Routes({ lang, t, lists, reload }: PartProps) {
  const session = useSession();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const s = t.settings;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  useLayoutEffect(() => () => setEditing(null), []);
  const typeName = (id: string | null) =>
    id
      ? inLang(lists.types.find((x) => x.id === id)?.name) || s.unknownType
      : s.anyType;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{s.routesHelp}</p>
      <Panel>
        {lists.routes.length === 0 ? (
          <EmptyState>{s.noRoutes}</EmptyState>
        ) : (
          <ul>
            {lists.routes.map((route) => (
              <li key={route.id} className="border-b border-line px-4 py-3 last:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <bdi className="font-medium">{inLang(route.name)}</bdi>
                    <Pill tone="neutral">{typeName(route.documentTypeId)}</Pill>
                    {!route.active && <Pill tone="neutral">{s.inactive}</Pill>}
                  </div>
                  {editing !== route.id && (
                    <Button variant="secondary" onClick={() => setEditing(route.id)}>
                      {s.edit}
                    </Button>
                  )}
                </div>
                <ol className="mt-2 flex flex-col gap-1 text-sm">
                  {route.steps.map((step) => (
                    <li key={step.position} className="text-muted">
                      {fill(s.stepLine, {
                        position: String(step.position),
                        kind: t.stepKind[step.kind],
                        who: assigneeLabel(t, inLang, step.assignee),
                        days: durationFormat(lang)(step.dueInDays, "day"),
                      })}
                    </li>
                  ))}
                </ol>
                {editing === route.id && (
                  <RouteForm
                    lang={lang}
                    t={t}
                    lists={lists}
                    route={route}
                    onDone={async () => {
                      setEditing(null);
                      await reload();
                    }}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editing === "new" ? (
        <Panel title={s.newRoute}>
          <RouteForm
            lang={lang}
            t={t}
            lists={lists}
            route={null}
            onDone={async () => {
              setEditing(null);
              await reload();
            }}
            onCancel={() => setEditing(null)}
          />
        </Panel>
      ) : (
        <ReadOnlyFieldset>
          <div>
            <Button variant="secondary" onClick={() => setEditing("new")}>
              <Plus className="size-4" aria-hidden />
              {s.addRoute}
            </Button>
          </div>
        </ReadOnlyFieldset>
      )}
    </div>
  );
}

function RouteForm({
  lang,
  t,
  lists,
  route,
  onDone,
  onCancel,
}: PoliciesProps & {
  lists: Lists;
  route: ApprovalRoute | null;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const session = useSession();
  const { locales } = session.tenant;
  const readOnly = useReadOnly();
  const explainError = useExplain(t, lang);
  const s = t.settings;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const [name, setName] = useState<Localized>(route?.name ?? {});
  const [typeId, setTypeId] = useState(route?.documentTypeId ?? "");
  const [active, setActive] = useState(route?.active ?? true);
  const [steps, setSteps] = useState<StepDraft[]>(
    route?.steps.map((x) => ({
      kind: x.kind,
      by: x.assignee.type,
      roleId: x.assignee.type === "role" ? x.assignee.role.id : "",
      userId: x.assignee.type === "user" ? (x.assignee.user?.id ?? "") : "",
      dueInDays: String(x.dueInDays),
    })) ?? [
      { kind: "review", by: "role", roleId: "", userId: "", dueInDays: "7" },
      { kind: "approve", by: "role", roleId: "", userId: "", dueInDays: "7" },
    ],
  );
  const [busy, setBusy] = useState(false);
  const [message, say] = useMessage();

  // Roles that may be named: those that allow approving. Without the
  // right to list roles, those already named in the route.
  const roleChoices: Named[] = lists.roles
    ? lists.roles
        .filter((r) => r.approves)
        .map((r) => ({ id: r.id, name: r.name }))
    : (route?.steps ?? []).flatMap((x) =>
        x.assignee.type === "role" ? [x.assignee.role] : [],
      );
  const people: Named[] = [...lists.approvers];
  for (const x of route?.steps ?? []) {
    const named = x.assignee.type === "user" ? x.assignee.user : null;
    if (named && !people.some((p) => p.id === named.id)) people.push(named);
  }

  const change = (i: number, next: Partial<StepDraft>) =>
    setSteps((was) => was.map((x, j) => (j === i ? { ...x, ...next } : x)));
  const move = (i: number, by: -1 | 1) =>
    setSteps((was) => {
      const next = [...was];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = {
      name: kept(name, locales),
      documentTypeId: typeId || null,
      active,
      steps: steps.map((x) => ({
        kind: x.kind,
        ...(x.by === "role" ? { roleId: x.roleId } : { userId: x.userId }),
        dueInDays: Number(x.dueInDays),
      })),
    };
    setBusy(true);
    say(null);
    try {
      if (route) {
        await api(`/policies/approval-routes/${route.id}`, {
          method: "PATCH",
          body: { ...body, revision: route.revision },
        });
      } else {
        await api("/policies/approval-routes", { method: "POST", body });
      }
      await onDone();
    } catch (err) {
      say({
        ok: false,
        text: codeOf(err) === "stale_route" ? t.errors.stale_route : explainError(err),
      });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-4 p-4">
      <ReadOnlyFieldset>
        <NameInputs label={s.name} value={name} onChange={setName} maxLength={200} />
        <Field label={s.routeType} help={s.routeTypeHelp}>
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className={inputClass}
          >
            <option value="">{s.anyType}</option>
            {lists.types.map((x) => (
              <option key={x.id} value={x.id}>
                {inLang(x.name)}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="size-4 accent-accent"
          />
          {s.active}
        </label>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">{s.steps}</legend>
          <p className="text-xs text-muted">{s.stepsHelp}</p>
          {!lists.roles && <p className="text-xs text-muted">{s.rolesUnavailable}</p>}
          <ol className="flex flex-col gap-3">
            {steps.map((step, i) => (
              <li key={i} className="flex flex-col gap-3 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {fill(s.stepNumber, { position: String(i + 1) })}
                  </span>
                  <div className="flex gap-1">
                    <button type="button" aria-label={s.moveUp} title={s.moveUp} disabled={i === 0} onClick={() => move(i, -1)} className={iconButton}>
                      <ArrowUp className="size-4" aria-hidden />
                    </button>
                    <button type="button" aria-label={s.moveDown} title={s.moveDown} disabled={i === steps.length - 1} onClick={() => move(i, 1)} className={iconButton}>
                      <ArrowDown className="size-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={s.removeStep}
                      title={s.removeStep}
                      disabled={steps.length === 1}
                      onClick={() => setSteps((was) => was.filter((_, j) => j !== i))}
                      className={iconButton}
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={s.stepKind}>
                    <select
                      value={step.kind}
                      onChange={(e) => change(i, { kind: e.target.value as StepKind })}
                      className={inputClass}
                    >
                      <option value="review">{t.stepKind.review}</option>
                      <option value="approve">{t.stepKind.approve}</option>
                    </select>
                  </Field>
                  <Field label={s.assigneeType}>
                    <select
                      value={step.by}
                      onChange={(e) => change(i, { by: e.target.value as "role" | "user" })}
                      className={inputClass}
                    >
                      <option value="role">{s.byRole}</option>
                      <option value="user">{s.byPerson}</option>
                    </select>
                  </Field>
                  <Field label={s.dueInDays}>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={step.dueInDays}
                      onChange={(e) => change(i, { dueInDays: e.target.value })}
                      required
                      dir="ltr"
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                </div>
                {step.by === "role" ? (
                  <Field label={s.role} help={s.roleHelp}>
                    <select
                      value={step.roleId}
                      onChange={(e) => change(i, { roleId: e.target.value })}
                      required
                      className={inputClass}
                    >
                      <option value="" disabled>
                        {t.form.choose}
                      </option>
                      {roleChoices.map((r) => (
                        <option key={r.id} value={r.id}>
                          {inLang(r.name)}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field label={s.person} help={s.personHelp}>
                    <select
                      value={step.userId}
                      onChange={(e) => change(i, { userId: e.target.value })}
                      required
                      className={inputClass}
                    >
                      <option value="" disabled>
                        {t.form.choose}
                      </option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {inLang(p.name) || t.document.unknownPerson}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </li>
            ))}
          </ol>
          <div>
            <Button
              variant="secondary"
              disabled={steps.length >= 10}
              onClick={() =>
                setSteps((was) => [
                  ...was,
                  { kind: "approve", by: "role", roleId: "", userId: "", dueInDays: "7" },
                ])
              }
            >
              <Plus className="size-4" aria-hidden />
              {s.addStep}
            </Button>
          </div>
        </fieldset>
        {message}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || readOnly}>
            {route ? s.save : s.create}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t.actions.cancel}
          </Button>
        </div>
      </ReadOnlyFieldset>
    </form>
  );
}
