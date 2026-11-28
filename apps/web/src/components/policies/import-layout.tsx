"use client";

import { FileDown, FileStack } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { fill, languageNameIn, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { importPath, todayIn } from "@/lib/policies";
import {
  exampleCsv,
  exampleJson,
  exampleRows,
  IMPORT_MAX_CHARACTERS,
  IMPORT_MAX_DOCUMENTS,
  importColumns,
  perLanguageColumns,
  requiredColumns,
  saveFile,
  type ExampleWords,
} from "@/lib/policy-import";
import { loadLists, type Lists } from "./document-form";
import type { PoliciesProps } from "./types";

/**
 * How a file of documents to import is laid out, for whoever prepares it:
 * the columns, the codes of this organization, the limits of a batch, and
 * an example file in its own codes and languages to start from.
 */
export function ImportLayout({
  lang,
  t,
  examples,
}: PoliciesProps & {
  /** The example's words in each language, from each language's dictionary. */
  examples: Record<string, ExampleWords>;
}) {
  const session = useSession();
  const everywhere = session.scope?.["policies.manage"] === "all";
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState(false);
  const m = t.importing;
  const y = m.layout;
  const numbers = numberFormat(lang);
  const { locales, defaultLocale } = session.tenant;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, defaultLocale);
  useEffect(() => {
    if (!everywhere) return;
    let current = true;
    loadLists()
      .then((l) => current && setLists(l))
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, [everywhere]);

  const example = () =>
    exampleRows({
      lists: lists!,
      locales,
      defaultLocale,
      owner: inLang(session.user.name),
      today: todayIn(session.tenant.timeZone),
      words: examples,
    });

  const code = (text: string) => (
    <code dir="ltr" className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs break-all">
      {text}
    </code>
  );
  const named = languageNameIn(lang);

  const codeList = (items: { key: string; code: string; name: string; extra?: ReactNode }[]) => (
    <ul className="flex flex-col gap-2 px-4 py-3 text-sm">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            {code(item.code)}
            <bdi>{item.name}</bdi>
          </span>
          {item.extra}
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader
        title={y.title}
        description={y.description}
        actions={
          everywhere && (
            <ButtonLink variant="secondary" href={importPath(lang, "batch")}>
              <FileStack className="size-4" aria-hidden />
              {m.batchOpen}
            </ButtonLink>
          )
        }
      />
      {!everywhere ? (
        <EmptyState>{m.noAccess}</EmptyState>
      ) : problem ? (
        <EmptyState>{t.loadError}</EmptyState>
      ) : !lists ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <div className="mt-6 flex max-w-4xl flex-col gap-6">
          <Panel title={y.exampleTitle}>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-sm text-muted">
                {fill(y.exampleHelp, {
                  languages: new Intl.ListFormat(lang, { type: "conjunction" }).format(
                    locales.map(named),
                  ),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() =>
                    saveFile(`${y.exampleFile}.csv`, exampleCsv(example()), "text/csv;charset=utf-8")
                  }
                >
                  <FileDown className="size-4" aria-hidden />
                  {y.downloadCsv}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    saveFile(`${y.exampleFile}.json`, exampleJson(example()), "application/json")
                  }
                >
                  <FileDown className="size-4" aria-hidden />
                  {y.downloadJson}
                </Button>
              </div>
            </div>
          </Panel>

          <Panel title={y.rulesTitle}>
            <ul className="flex list-disc flex-col gap-2 py-3 ps-8 pe-4 text-sm">
              {y.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
              <li>
                {fill(y.limits, {
                  documents: numbers.format(IMPORT_MAX_DOCUMENTS),
                  characters: numbers.format(IMPORT_MAX_CHARACTERS),
                })}
              </li>
            </ul>
          </Panel>

          <Panel title={y.columnsTitle}>
            <p className="px-4 pt-3 text-sm text-muted">
              {fill(y.columnsHelp, {
                languages: locales.map((l) => l).join(", "),
                main: named(defaultLocale),
              })}
            </p>
            <ul className="mt-2">
              {importColumns.map((column) => (
                <li
                  key={column}
                  className="flex flex-col gap-1 border-t border-line px-4 py-3 text-sm"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {code(
                      column === "section"
                        ? `section.<${y.sectionKeyWord}>.<${y.languageWord}>`
                        : perLanguageColumns.includes(column)
                          ? `${column}.<${y.languageWord}>`
                          : column,
                    )}
                    <span className="font-medium">{m.columns[column]}</span>
                    {requiredColumns.includes(column) ? (
                      <Pill tone="warn">{t.editor.required}</Pill>
                    ) : (
                      <Pill tone="neutral">{t.editor.optional}</Pill>
                    )}
                  </span>
                  <span className="text-muted">{y.columnHelp[column]}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={y.codesTitle}>
            <p className="px-4 pt-3 text-sm text-muted">{y.codesHelp}</p>
            <h3 className="px-4 pt-4 text-sm font-semibold">{y.types}</h3>
            {codeList(
              lists.types.map((x) => ({
                key: x.id,
                code: x.code,
                name: inLang(x.name),
                extra: (
                  <span className="text-xs text-muted">
                    {y.sectionKeys}{" "}
                    {x.sections.map((s, i) => (
                      <span key={s.key}>
                        {i > 0 && ", "}
                        <bdi dir="ltr" className="font-mono">
                          {s.key}
                        </bdi>{" "}
                        <bdi>({inLang(s.name)}{s.required ? ` · ${t.editor.required}` : ""})</bdi>
                      </span>
                    ))}
                  </span>
                ),
              })),
            )}
            <h3 className="border-t border-line px-4 pt-4 text-sm font-semibold">{y.categories}</h3>
            {codeList(
              lists.categories
                .filter((c) => c.active)
                .map((c) => ({ key: c.id, code: c.code, name: inLang(c.name) })),
            )}
            <h3 className="border-t border-line px-4 pt-4 text-sm font-semibold">{y.areas}</h3>
            {codeList(
              lists.units
                .filter((u) => u.active)
                .map((u) => ({ key: u.id, code: u.code, name: inLang(u.name) })),
            )}
            {lists.roles && (
              <>
                <h3 className="border-t border-line px-4 pt-4 text-sm font-semibold">{y.roles}</h3>
                {codeList(
                  lists.roles.map((r) => ({ key: r.id, code: r.code, name: inLang(r.name) })),
                )}
              </>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
