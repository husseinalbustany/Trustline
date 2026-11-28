"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, codeOf, statusOf } from "@/lib/api";
import { fill, languageNameIn } from "@/lib/format";
import type { Role } from "@/lib/identity";
import { pick, type Localized } from "@/lib/localized";
import { SettingsTabs } from "./settings-tabs";

type L = Localized | null;

export type Profile = {
  revision: number;
  identity: {
    legalName: L;
    tradingName: L;
    sector: string;
    organizationType: L;
    ownership: string | null;
    staffCount: number | null;
    siteCount: number | null;
    measures: { label: L; value: number | null }[];
  };
  services: { provided: L[]; notProvided: L[] };
  committees: { name: L; approves: L }[];
  titles: { title: L; roleId: string | null }[];
  standards: { kind: string; name: L; edition: string | null }[];
  glossary: { preferred: L; avoid: L; note: L }[];
  abbreviations: { short: string; meaning: L }[];
  houseRules: { documentOwners: L; retention: L; other: L };
  relatedSystems: { name: string; purpose: L }[];
  fromSettings?: {
    languages: string[];
    defaultLocale: string;
    authoritativeLocale: string | null;
    documentTypes: { id: string; name: Localized; numberPrefix: string; defaultReviewMonths: number }[];
  };
};

type Text = Dictionary["profile"];

const sectors = [
  "healthcare",
  "manufacturing",
  "logistics",
  "education",
  "public_sector",
  "services",
  "retail",
  "energy",
  "construction",
  "other",
] as const;
const ownerships = ["public", "private", "non_profit", "mixed"] as const;
const standardKinds = ["standard", "regulation", "licensing_body"] as const;

/** Text the organization writes, one input per language it works in. */
function LocalizedInputs({
  label,
  value,
  onChange,
  required,
  multiline,
  help,
}: {
  label: string;
  value: L;
  onChange: (v: L) => void;
  required?: boolean;
  multiline?: boolean;
  help?: string;
}) {
  const session = useSession();
  const { locales, defaultLocale } = session.tenant;
  const set = (locale: string, text: string) => {
    const next: Record<string, string> = { ...(value ?? {}) } as Record<string, string>;
    if (text) next[locale] = text;
    else delete next[locale];
    onChange(Object.keys(next).length ? (next as Localized) : null);
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {locales.map((l) => {
        const v = (value as Record<string, string> | null)?.[l] ?? "";
        const props = {
          value: v,
          onChange: (e: { target: { value: string } }) => set(l, e.target.value),
          required: required && l === defaultLocale,
          dir: "auto" as const,
          lang: l,
          "aria-label": `${label} · ${languageNameIn(l)(l)}`,
        };
        return (
          <label key={l} className="flex flex-col gap-1 text-xs text-muted">
            {languageNameIn(l)(l)}
            {multiline ? (
              <textarea {...props} rows={2} maxLength={2000} className={`${inputClass} h-auto py-2`} />
            ) : (
              <input {...props} maxLength={300} className={inputClass} />
            )}
          </label>
        );
      })}
      {help && <span className="text-xs text-muted">{help}</span>}
    </fieldset>
  );
}

/** A list of rows, each with its own fields, added and removed one by one. */
function Rows<T>({
  t,
  title,
  help,
  rows,
  max,
  blank,
  onChange,
  render,
}: {
  t: Text;
  title: string;
  help?: string;
  rows: T[];
  max: number;
  blank: T;
  onChange: (rows: T[]) => void;
  render: (row: T, set: (row: T) => void) => ReactNode;
}) {
  return (
    <Panel title={title}>
      <div className="flex flex-col gap-4 p-4">
        {help && <p className="text-sm text-muted">{help}</p>}
        {rows.length === 0 && <p className="text-sm text-muted">{t.none}</p>}
        {rows.map((row, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-md border border-line p-3">
            {render(row, (next) => onChange(rows.map((r, j) => (j === i ? next : r))))}
            <div>
              <button
                type="button"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="inline-flex items-center gap-1 text-sm text-danger hover:underline"
              >
                <Trash2 className="size-4" aria-hidden />
                {t.remove}
              </button>
            </div>
          </div>
        ))}
        {rows.length < max && (
          <div>
            <Button variant="secondary" onClick={() => onChange([...rows, blank])}>
              <Plus className="size-4" aria-hidden />
              {t.add}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

const numberOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

/**
 * What the organization is, does and calls things: the profile the
 * assistant drafts from, and what every document can rely on. Written per
 * language; what other settings already say is shown, not asked again.
 */
export function OrganizationProfile({
  lang,
  t,
  tabs,
}: {
  lang: string;
  t: Text;
  tabs: Dictionary["admin"]["settings"]["tabs"];
}) {
  const session = useSession();
  const whole = session.scope?.["settings.manage"] === "all";
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useLayoutEffect(() => () => setMessage(null), []);
  const inLang = (text: L | undefined) => pick(text, lang, session.tenant.defaultLocale);
  const languageName = languageNameIn(lang);

  useEffect(() => {
    if (!whole) return;
    let current = true;
    api<Profile>("/settings/profile").then(
      (p) => {
        if (current) setProfile(p);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 403 ? t.noAccess : t.loadError);
      },
    );
    api<{ roles: Role[] }>("/roles").then(
      (r) => {
        if (current) setRoles(r.roles);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [whole, t]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!profile) return;
    setBusy(true);
    setMessage(null);
    // Everything but what is taken from the other settings.
    const { fromSettings: _shown, ...body } = profile;
    void _shown;
    try {
      setProfile(await api<Profile>("/settings/profile", { method: "PUT", body }));
      setMessage({ ok: true, text: t.saved });
    } catch (err) {
      const code = codeOf(err);
      if (code === "profile_changed") {
        api<Profile>("/settings/profile").then(setProfile, () => {});
      }
      setMessage({
        ok: false,
        text:
          code === "profile_changed"
            ? t.changed
            : code === "language_mismatch"
              ? t.languageMismatch
              : code === "unknown_role"
                ? t.unknownRole
                : statusOf(err) === 400
                  ? t.invalid
                  : t.error,
      });
    }
    setBusy(false);
  }

  const p = profile;
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((was) => (was ? { ...was, [key]: value } : was));
  const setId = <K extends keyof Profile["identity"]>(key: K, value: Profile["identity"][K]) =>
    setProfile((was) => (was ? { ...was, identity: { ...was.identity, [key]: value } } : was));

  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <SettingsTabs lang={lang} t={tabs} current="profile" />
      <div className="mt-6 max-w-3xl">
        {!whole ? (
          <Panel>
            <EmptyState>{t.noAccess}</EmptyState>
          </Panel>
        ) : problem ? (
          <Panel>
            <EmptyState>{problem}</EmptyState>
          </Panel>
        ) : !p ? (
          <Panel>
            <EmptyState>{t.loading}</EmptyState>
          </Panel>
        ) : (
          <form key={p.revision} onSubmit={save} className="flex flex-col gap-6">
            <Panel title={t.identity}>
              <div className="flex flex-col gap-5 p-4">
                <LocalizedInputs label={t.legalName} value={p.identity.legalName} onChange={(v) => setId("legalName", v)} required />
                <LocalizedInputs label={t.tradingName} value={p.identity.tradingName} onChange={(v) => setId("tradingName", v)} />
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t.sector}>
                    <select value={p.identity.sector} onChange={(e) => setId("sector", e.target.value)} className={inputClass}>
                      {sectors.map((x) => (
                        <option key={x} value={x}>
                          {t.sectors[x]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t.ownershipLabel}>
                    <select
                      value={p.identity.ownership ?? ""}
                      onChange={(e) => setId("ownership", e.target.value || null)}
                      className={inputClass}
                    >
                      <option value="">{t.notSaid}</option>
                      {ownerships.map((x) => (
                        <option key={x} value={x}>
                          {t.ownership[x]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t.staffCount}>
                    <input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      dir="ltr"
                      value={p.identity.staffCount ?? ""}
                      onChange={(e) => setId("staffCount", numberOrNull(e.target.value))}
                      className={inputClass}
                    />
                  </Field>
                  <Field label={t.siteCount}>
                    <input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      dir="ltr"
                      value={p.identity.siteCount ?? ""}
                      onChange={(e) => setId("siteCount", numberOrNull(e.target.value))}
                      className={inputClass}
                    />
                  </Field>
                </div>
                <LocalizedInputs
                  label={t.organizationType}
                  help={t.organizationTypeHelp}
                  value={p.identity.organizationType}
                  onChange={(v) => setId("organizationType", v)}
                />
              </div>
            </Panel>

            <Rows
              t={t}
              title={t.measures}
              help={t.measuresHelp}
              rows={p.identity.measures}
              max={10}
              blank={{ label: null, value: null }}
              onChange={(rows) => setId("measures", rows)}
              render={(row, setRow) => (
                <>
                  <LocalizedInputs label={t.measureLabel} value={row.label} onChange={(v) => setRow({ ...row, label: v })} required />
                  <Field label={t.measureValue}>
                    <input
                      type="number"
                      dir="ltr"
                      inputMode="decimal"
                      value={row.value ?? ""}
                      onChange={(e) => setRow({ ...row, value: numberOrNull(e.target.value) })}
                      className={`${inputClass} max-w-40`}
                    />
                  </Field>
                </>
              )}
            />

            <Rows
              t={t}
              title={t.provided}
              help={t.providedHelp}
              rows={p.services.provided}
              max={100}
              blank={null}
              onChange={(rows) => set("services", { ...p.services, provided: rows })}
              render={(row, setRow) => <LocalizedInputs label={t.service} value={row} onChange={setRow} required />}
            />
            <Rows
              t={t}
              title={t.notProvided}
              help={t.notProvidedHelp}
              rows={p.services.notProvided}
              max={100}
              blank={null}
              onChange={(rows) => set("services", { ...p.services, notProvided: rows })}
              render={(row, setRow) => <LocalizedInputs label={t.service} value={row} onChange={setRow} required />}
            />

            <Rows
              t={t}
              title={t.committees}
              help={t.committeesHelp}
              rows={p.committees}
              max={50}
              blank={{ name: null, approves: null }}
              onChange={(rows) => set("committees", rows)}
              render={(row, setRow) => (
                <>
                  <LocalizedInputs label={t.committeeName} value={row.name} onChange={(v) => setRow({ ...row, name: v })} required />
                  <LocalizedInputs label={t.committeeApproves} value={row.approves} onChange={(v) => setRow({ ...row, approves: v })} />
                </>
              )}
            />

            <Rows
              t={t}
              title={t.titles}
              help={t.titlesHelp}
              rows={p.titles}
              max={200}
              blank={{ title: null, roleId: null }}
              onChange={(rows) => set("titles", rows)}
              render={(row, setRow) => (
                <>
                  <LocalizedInputs label={t.jobTitle} value={row.title} onChange={(v) => setRow({ ...row, title: v })} required />
                  <Field label={t.role}>
                    <select
                      value={row.roleId ?? ""}
                      onChange={(e) => setRow({ ...row, roleId: e.target.value || null })}
                      className={inputClass}
                    >
                      <option value="">{t.noRole}</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {inLang(r.name)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
            />

            <Rows
              t={t}
              title={t.standards}
              help={t.standardsHelp}
              rows={p.standards}
              max={50}
              blank={{ kind: "standard", name: null, edition: null }}
              onChange={(rows) => set("standards", rows)}
              render={(row, setRow) => (
                <>
                  <Field label={t.standardKind}>
                    <select value={row.kind} onChange={(e) => setRow({ ...row, kind: e.target.value })} className={inputClass}>
                      {standardKinds.map((x) => (
                        <option key={x} value={x}>
                          {t.standardKinds[x]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <LocalizedInputs label={t.standardName} value={row.name} onChange={(v) => setRow({ ...row, name: v })} required />
                  <Field label={t.edition}>
                    <input
                      value={row.edition ?? ""}
                      maxLength={100}
                      dir="auto"
                      onChange={(e) => setRow({ ...row, edition: e.target.value || null })}
                      className={inputClass}
                    />
                  </Field>
                </>
              )}
            />

            <Rows
              t={t}
              title={t.glossary}
              help={t.glossaryHelp}
              rows={p.glossary}
              max={300}
              blank={{ preferred: null, avoid: null, note: null }}
              onChange={(rows) => set("glossary", rows)}
              render={(row, setRow) => (
                <>
                  <LocalizedInputs label={t.preferred} value={row.preferred} onChange={(v) => setRow({ ...row, preferred: v })} required />
                  <LocalizedInputs label={t.avoid} value={row.avoid} onChange={(v) => setRow({ ...row, avoid: v })} />
                  <LocalizedInputs label={t.note} value={row.note} onChange={(v) => setRow({ ...row, note: v })} />
                </>
              )}
            />

            <Rows
              t={t}
              title={t.abbreviations}
              rows={p.abbreviations}
              max={200}
              blank={{ short: "", meaning: null }}
              onChange={(rows) => set("abbreviations", rows)}
              render={(row, setRow) => (
                <>
                  <Field label={t.short}>
                    <input
                      value={row.short}
                      required
                      maxLength={30}
                      dir="auto"
                      onChange={(e) => setRow({ ...row, short: e.target.value })}
                      className={`${inputClass} max-w-40`}
                    />
                  </Field>
                  <LocalizedInputs label={t.meaning} value={row.meaning} onChange={(v) => setRow({ ...row, meaning: v })} required />
                </>
              )}
            />

            <Panel title={t.houseRules}>
              <div className="flex flex-col gap-5 p-4">
                <p className="text-sm text-muted">{t.houseRulesHelp}</p>
                <LocalizedInputs multiline label={t.documentOwners} value={p.houseRules.documentOwners} onChange={(v) => set("houseRules", { ...p.houseRules, documentOwners: v })} />
                <LocalizedInputs multiline label={t.retention} value={p.houseRules.retention} onChange={(v) => set("houseRules", { ...p.houseRules, retention: v })} />
                <LocalizedInputs multiline label={t.otherRules} value={p.houseRules.other} onChange={(v) => set("houseRules", { ...p.houseRules, other: v })} />
              </div>
            </Panel>

            <Rows
              t={t}
              title={t.relatedSystems}
              help={t.relatedSystemsHelp}
              rows={p.relatedSystems}
              max={50}
              blank={{ name: "", purpose: null }}
              onChange={(rows) => set("relatedSystems", rows)}
              render={(row, setRow) => (
                <>
                  <Field label={t.systemName}>
                    <input
                      value={row.name}
                      required
                      maxLength={100}
                      dir="auto"
                      onChange={(e) => setRow({ ...row, name: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <LocalizedInputs label={t.systemPurpose} value={row.purpose} onChange={(v) => setRow({ ...row, purpose: v })} />
                </>
              )}
            />

            {p.fromSettings && (
              <Panel title={t.fromSettings}>
                <div className="flex flex-col gap-2 p-4 text-sm">
                  <p className="text-muted">{t.fromSettingsHelp}</p>
                  <p>
                    {fill(t.languages, {
                      languages: p.fromSettings.languages.map((l) => languageName(l)).join(", "),
                    })}
                  </p>
                  <p>{fill(t.defaultLanguage, { language: languageName(p.fromSettings.defaultLocale) })}</p>
                  <ul className="list-disc ps-5">
                    {p.fromSettings.documentTypes.map((x) => (
                      <li key={x.id}>
                        <bdi>{inLang(x.name)}</bdi>{" "}
                        <bdi dir="ltr" className="text-muted">
                          {x.numberPrefix}
                        </bdi>
                      </li>
                    ))}
                  </ul>
                </div>
              </Panel>
            )}

            {message && (
              <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
                {message.text}
              </p>
            )}
            <div>
              <Button type="submit" disabled={busy}>
                {t.save}
              </Button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
