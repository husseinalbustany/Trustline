"use client";

import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, detailsOf, statusOf } from "@/lib/api";
import { fill, languageNameIn } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import type { DocumentType } from "@/lib/policies";
import { direction } from "@/i18n/config";
import type { PoliciesProps } from "./types";

type L = Localized | null;

const controlFields = ["number", "title", "version", "owner", "effectiveOn", "reviewOn", "approvals"] as const;

type Design = {
  id: string | null;
  source: "type" | "organization" | "defaults" | (string & {});
  version: number;
  template: {
    header: L;
    footer: L;
    showLogo: boolean;
    font: "sans" | "serif" | (string & {});
    accentColor: string;
    controlBlock: string[];
    bilingualLayout: string;
  };
  writing: {
    rules: Localized[];
    maxSentenceWords: number | null;
    steps: string;
    requirements: string;
    citations: string;
    useGlossary: boolean;
    never: Localized[];
  };
  sectionGuidance: Record<string, Localized>;
  type: { id: string; name: Localized; sections: { key: string; name: Localized; required: boolean }[] } | null;
};

/** One text per language the organization works in, held by the form. */
function PerLanguage({
  label,
  value,
  onChange,
  rows = 1,
  help,
}: {
  label: string;
  value: L;
  onChange: (v: L) => void;
  rows?: number;
  help?: string;
}) {
  const { locales } = useSession().tenant;
  const set = (locale: string, text: string) => {
    const next = { ...(value ?? {}) } as Record<string, string>;
    if (text) next[locale] = text;
    else delete next[locale];
    onChange(Object.keys(next).length ? (next as Localized) : null);
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {locales.map((l) => {
        const v = (value as Record<string, string> | null)?.[l] ?? "";
        const name = languageNameIn(l)(l);
        return (
          <label key={l} className="flex flex-col gap-1 text-xs text-muted">
            {name}
            {rows > 1 ? (
              <textarea
                value={v}
                rows={rows}
                maxLength={2000}
                lang={l}
                dir={direction(l)}
                onChange={(e) => set(l, e.target.value)}
                className={`${inputClass} h-auto py-2`}
              />
            ) : (
              <input
                value={v}
                maxLength={300}
                lang={l}
                dir={direction(l)}
                onChange={(e) => set(l, e.target.value)}
                className={inputClass}
              />
            )}
          </label>
        );
      })}
      {help && <span className="text-xs text-muted">{help}</span>}
    </fieldset>
  );
}

/** One line per rule; the lines of each language kept apart. */
const linesOf = (list: Localized[], locale: string) =>
  list.map((x) => (x as Record<string, string>)[locale] ?? "").join("\n");
function fromLines(byLocale: Record<string, string>): Localized[] {
  const split = Object.entries(byLocale).map(([l, text]) => [l, text.split("\n")] as const);
  const count = Math.max(0, ...split.map(([, lines]) => lines.length));
  const out: Localized[] = [];
  for (let i = 0; i < count; i++) {
    const item: Record<string, string> = {};
    for (const [l, lines] of split) if (lines[i]?.trim()) item[l] = lines[i].trim();
    if (Object.keys(item).length) out.push(item as Localized);
  }
  return out;
}

/**
 * How documents look and are written: the organization's design, or a
 * type's own. Its template, its writing rules and guidance for each of the
 * type's sections, written per language. The sections themselves are the
 * type's, set under document types.
 */
export function DocumentDesign({ lang, t, types }: PoliciesProps & { types: DocumentType[] }) {
  const session = useSession();
  const s = t.design;
  const [typeId, setTypeId] = useState("");
  const [answer, setAnswer] = useState<{ typeId: string; design: Design } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [rules, setRules] = useState<Record<string, string>>({});
  const [never, setNever] = useState<Record<string, string>>({});
  useLayoutEffect(() => () => setMessage(null), []);
  const inLang = (text: L | undefined) => pick(text, lang, session.tenant.defaultLocale);
  const { locales } = session.tenant;

  useEffect(() => {
    let current = true;
    api<Design>(`/policies/design${typeId ? `?${new URLSearchParams({ documentTypeId: typeId })}` : ""}`).then(
      (design) => {
        if (!current) return;
        setAnswer({ typeId, design });
        setRules(Object.fromEntries(locales.map((l) => [l, linesOf(design.writing.rules, l)])));
        setNever(Object.fromEntries(locales.map((l) => [l, linesOf(design.writing.never, l)])));
        setProblem(null);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 403 ? s.noAccess : t.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [typeId, s, t, locales]);

  const design = answer?.typeId === typeId ? answer.design : null;
  const setDesign = (next: Design) => setAnswer({ typeId, design: next });

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!design) return;
    setBusy(true);
    setMessage(null);
    // A design of its own: the version read, or 0 when it followed another.
    const own = typeId ? design.source === "type" : design.source === "organization";
    try {
      const saved = await api<Design>("/policies/design", {
        method: "PUT",
        body: {
          documentTypeId: typeId || null,
          template: design.template,
          writing: { ...design.writing, rules: fromLines(rules), never: fromLines(never) },
          sectionGuidance: design.sectionGuidance,
          version: own ? design.version : 0,
        },
      });
      setDesign(saved);
      setMessage({ ok: true, text: s.saved });
    } catch (err) {
      const code = codeOf(err);
      setMessage({
        ok: false,
        text:
          code === "design_changed"
            ? s.changed
            : code === "unknown_section"
              ? fill(s.unknownSection, { section: String(detailsOf(err).section ?? "") })
              : code === "language_mismatch"
                ? s.languageMismatch
                : statusOf(err) === 400
                  ? s.invalid
                  : s.error,
      });
    }
    setBusy(false);
  }

  const tpl = design?.template;
  const wr = design?.writing;
  const setTpl = (patch: Partial<Design["template"]>) => design && setDesign({ ...design, template: { ...design.template, ...patch } });
  const setWr = (patch: Partial<Design["writing"]>) => design && setDesign({ ...design, writing: { ...design.writing, ...patch } });
  const sources = s.source as Record<string, string>;
  // The sections guidance is written for: the type's, or every type's.
  const sections = design?.type
    ? design.type.sections
    : Array.from(
        new Map(types.flatMap((x) => x.sections).map((sec) => [sec.key, sec])).values(),
      );

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Field label={s.forLabel} help={s.forHelp}>
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputClass}>
          <option value="">{s.organization}</option>
          {types.map((x) => (
            <option key={x.id} value={x.id}>
              {inLang(x.name)}
            </option>
          ))}
        </select>
      </Field>
      {problem ? (
        <EmptyState>{problem}</EmptyState>
      ) : !design || !tpl || !wr ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <form key={`${typeId}:${design.version}`} onSubmit={save} className="flex flex-col gap-6">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Pill tone="neutral">{sources[design.source] ?? design.source}</Pill>
            <span className="text-muted">{(s.sourceHelp as Record<string, string>)[design.source] ?? ""}</span>
          </p>

          <Panel title={s.template}>
            <div className="flex flex-col gap-5 p-4">
              <PerLanguage label={s.header} value={tpl.header} onChange={(v) => setTpl({ header: v })} />
              <PerLanguage label={s.footer} value={tpl.footer} onChange={(v) => setTpl({ footer: v })} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={tpl.showLogo} onChange={(e) => setTpl({ showLogo: e.target.checked })} className="size-4" />
                {s.showLogo}
              </label>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={s.font}>
                  <select value={tpl.font} onChange={(e) => setTpl({ font: e.target.value })} className={inputClass}>
                    {(["sans", "serif"] as const).map((x) => (
                      <option key={x} value={x}>
                        {s.fonts[x]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={s.accentColor} help={s.accentColorHelp}>
                  <span className="flex items-center gap-2">
                    <input
                      type="color"
                      value={tpl.accentColor}
                      onChange={(e) => setTpl({ accentColor: e.target.value.toUpperCase() })}
                      className="h-10 w-12 rounded border border-line"
                      aria-label={s.accentColor}
                    />
                    <input
                      value={tpl.accentColor}
                      pattern="#[0-9A-Fa-f]{6}"
                      dir="ltr"
                      onChange={(e) => setTpl({ accentColor: e.target.value })}
                      className={`${inputClass} max-w-32`}
                      aria-label={s.accentColor}
                    />
                  </span>
                </Field>
                <Field label={s.bilingual}>
                  <select value={tpl.bilingualLayout} onChange={(e) => setTpl({ bilingualLayout: e.target.value })} className={inputClass}>
                    {(["one_language_per_document", "side_by_side", "one_after_another"] as const).map((x) => (
                      <option key={x} value={x}>
                        {s.bilingualLayout[x]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{s.controlBlock}</legend>
                <p className="text-xs text-muted">{s.controlBlockHelp}</p>
                {controlFields.map((x) => (
                  <label key={x} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={tpl.controlBlock.includes(x)}
                      onChange={(e) =>
                        setTpl({
                          controlBlock: e.target.checked
                            ? controlFields.filter((f) => f === x || tpl.controlBlock.includes(f))
                            : tpl.controlBlock.filter((f) => f !== x),
                        })
                      }
                      className="size-4"
                    />
                    {s.controlFields[x]}
                  </label>
                ))}
              </fieldset>
            </div>
          </Panel>

          <Panel title={s.writing}>
            <div className="flex flex-col gap-5 p-4">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{s.rules}</legend>
                <p className="text-xs text-muted">{s.rulesHelp}</p>
                {locales.map((l) => (
                  <label key={l} className="flex flex-col gap-1 text-xs text-muted">
                    {languageNameIn(l)(l)}
                    <textarea
                      value={rules[l] ?? ""}
                      rows={4}
                      lang={l}
                      dir={direction(l)}
                      onChange={(e) => setRules({ ...rules, [l]: e.target.value })}
                      className={`${inputClass} h-auto py-2`}
                    />
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={s.maxSentenceWords}>
                  <input
                    type="number"
                    min={5}
                    max={80}
                    dir="ltr"
                    value={wr.maxSentenceWords ?? ""}
                    onChange={(e) => setWr({ maxSentenceWords: e.target.value ? Number(e.target.value) : null })}
                    className={`${inputClass} max-w-32`}
                  />
                </Field>
                <Field label={s.stepsLabel}>
                  <select value={wr.steps} onChange={(e) => setWr({ steps: e.target.value })} className={inputClass}>
                    {(["numbered_one_action", "numbered"] as const).map((x) => (
                      <option key={x} value={x}>
                        {s.steps[x]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={s.requirementsLabel}>
                  <select value={wr.requirements} onChange={(e) => setWr({ requirements: e.target.value })} className={inputClass}>
                    {(["must_should_may", "shall_should_may"] as const).map((x) => (
                      <option key={x} value={x}>
                        {s.requirements[x]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={s.citationsLabel}>
                  <select value={wr.citations} onChange={(e) => setWr({ citations: e.target.value })} className={inputClass}>
                    {(["by_number", "by_number_and_title"] as const).map((x) => (
                      <option key={x} value={x}>
                        {s.citations[x]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={wr.useGlossary} onChange={(e) => setWr({ useGlossary: e.target.checked })} className="size-4" />
                {s.useGlossary}
              </label>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{s.never}</legend>
                <p className="text-xs text-muted">{s.neverHelp}</p>
                {locales.map((l) => (
                  <label key={l} className="flex flex-col gap-1 text-xs text-muted">
                    {languageNameIn(l)(l)}
                    <textarea
                      value={never[l] ?? ""}
                      rows={3}
                      lang={l}
                      dir={direction(l)}
                      onChange={(e) => setNever({ ...never, [l]: e.target.value })}
                      className={`${inputClass} h-auto py-2`}
                    />
                  </label>
                ))}
              </fieldset>
            </div>
          </Panel>

          <Panel title={s.sections}>
            <div className="flex flex-col gap-5 p-4">
              <p className="text-sm text-muted">{s.sectionsHelp}</p>
              {sections.map((sec) => (
                <PerLanguage
                  key={sec.key}
                  label={inLang(sec.name)}
                  rows={2}
                  value={design.sectionGuidance[sec.key] ?? null}
                  onChange={(v) => {
                    const next = { ...design.sectionGuidance };
                    if (v) next[sec.key] = v;
                    else delete next[sec.key];
                    setDesign({ ...design, sectionGuidance: next });
                  }}
                />
              ))}
            </div>
          </Panel>

          {message && (
            <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
              {message.text}
            </p>
          )}
          <div>
            <Button type="submit" disabled={busy}>
              {s.save}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
