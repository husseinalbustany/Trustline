"use client";

import { FileText, FileUp } from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { useSession } from "@/components/shell/session";
import { useReadOnly } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, detailsOf } from "@/lib/api";
import { fill, languageNameIn, numberFormat } from "@/lib/format";
import { pick, readForm, type Localized } from "@/lib/localized";
import {
  documentPath,
  importPath,
  todayIn,
  type Person,
  type PolicySettings,
} from "@/lib/policies";
import {
  columnOfField,
  findType,
  IMPORT_MAX_CHARACTERS,
  IMPORT_MAX_DOCUMENTS,
  peopleNamed,
  readImportFile,
  splitIntoBatches,
  toImportDocument,
  type CheckedDocument,
  type FileProblem,
  type ImportDocument,
  type ImportedBatch,
  type ImportLists,
  type ImportProblem,
  type LocalProblem,
  type RowFields,
} from "@/lib/policy-import";
import { loadLists } from "./document-form";
import {
  asRefusal,
  CheckedLines,
  ImportWindowNote,
  importWindowOf,
  NotedDifferences,
  OriginalFields,
  windowClosed,
  readSections,
  SectionsFields,
} from "./import-form";
import { PasswordPrompt } from "./password-prompt";
import { Words } from "./sentence";
import type { PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

/** The largest file read, in bytes: far more than any batch of documents. */
const FILE_MAX = 20 * 1024 * 1024;

type Row = {
  key: string;
  /** Its line (CSV) or place (JSON) in the file. */
  at: number;
  fields: RowFields;
  /** The owner chosen when correcting it; else found by the name in the file. */
  ownerId: string | null;
  /** People whose name is the one in the file. */
  candidates: Person[];
  left: boolean;
  imported: { id: string; number: string } | null;
};

type CheckState =
  | { status: "ok"; documents: CheckedDocument[] }
  | { status: "refused"; problems: ImportProblem[] }
  | { status: "failed"; text: string };

type Ready = { lists: ImportLists & { maxReviewMonths: number | null }; settings: PolicySettings | null };

/** A short, stable name for what a batch holds: a change makes it another. */
function signatureOf(bodies: ImportDocument[]) {
  const text = JSON.stringify(bodies);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${bodies.length}:${text.length}:${(h >>> 0).toString(36)}`;
}

/**
 * Importing documents from a file, in batches: the file is read, each row
 * checked by the API (`/imports/check`) without the password, problems
 * shown per row to correct or leave out, then each batch signed with the
 * password, one signature per batch.
 */
export function ImportBatchPage({ lang, t }: PoliciesProps) {
  const session = useSession();
  const everywhere = session.scope?.["policies.manage"] === "all";
  const [ready, setReady] = useState<Ready | null>(null);
  const [problem, setProblem] = useState(false);
  const m = t.importing;
  useEffect(() => {
    if (!everywhere) return;
    let current = true;
    Promise.all([
      loadLists(),
      api<PolicySettings>("/policies/settings").catch(() => null),
    ])
      .then(([lists, settings]) => current && setReady({ lists, settings }))
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, [everywhere]);
  return (
    <>
      <PageHeader
        title={m.batchTitle}
        description={fill(m.batchDescription, {
          documents: numberFormat(lang).format(IMPORT_MAX_DOCUMENTS),
          characters: numberFormat(lang).format(IMPORT_MAX_CHARACTERS),
        })}
        actions={
          everywhere && (
            <ButtonLink variant="secondary" href={importPath(lang, "layout")}>
              <FileText className="size-4" aria-hidden />
              {m.layoutOpen}
            </ButtonLink>
          )
        }
      />
      {!everywhere ? (
        <EmptyState>{m.noAccess}</EmptyState>
      ) : problem ? (
        <EmptyState>{t.loadError}</EmptyState>
      ) : !ready ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <>
          <ImportWindowNote lang={lang} t={t} window={importWindowOf(ready.settings)} />
          <Batches lang={lang} t={t} ready={ready} />
        </>
      )}
    </>
  );
}

function Batches({ lang, t, ready }: PoliciesProps & { ready: Ready }) {
  const session = useSession();
  const readOnly = useReadOnly();
  const { lists, settings } = ready;
  const authoritative = settings?.authoritative ?? session.tenant.defaultLocale;
  // Nothing can be imported once the window has closed.
  const closed = windowClosed(importWindowOf(settings), todayIn(session.tenant.timeZone));
  const m = t.importing;
  const numbers = numberFormat(lang);
  // Names in a row, each kept in its own direction: "type, area".
  const unitList = (items: string[]) =>
    new Intl.ListFormat(lang, { type: "unit" }).format(
      items.map((x) => `\u2068${x}\u2069`),
    );
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const explainError = useExplain(t, lang, lists.types.flatMap((x) => x.sections));
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{
    name: string;
    kind: "csv" | "json";
    rows: Row[];
  } | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const asked = useRef(new Set<string>());
  const [editing, setEditing] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const [signedCount, setSignedCount] = useState(0);
  const [said, setSaid] = useState<string | null>(null);

  // Hidden pages stay mounted: a password prompt and a message do not wait there.
  useLayoutEffect(
    () => () => {
      setSigning(null);
      setSaid(null);
    },
    [],
  );

  const rows = file?.rows ?? [];
  const resolved = rows.map((row) => ({
    row,
    ...toImportDocument(row.fields, lists, {
      id: row.ownerId,
      candidates: row.candidates,
    }),
  }));
  const open = resolved.filter((x) => !x.row.left && !x.row.imported);
  const toCorrect = open.filter((x) => !x.body);
  const batches = splitIntoBatches(
    open.filter((x) => x.body),
    (x) => x.body!,
  ).map((items) => {
    const bodies = items.map((x) => x.body!);
    return { items, bodies, signature: signatureOf(bodies) };
  });
  const signatures = batches.map((b) => b.signature).join(" ");

  // Each batch is checked by the API as soon as it is what it is; the
  // answer is kept for what was sent, so a change is checked again.
  useEffect(() => {
    for (const batch of batches) {
      if (asked.current.has(batch.signature)) continue;
      asked.current.add(batch.signature);
      const signature = batch.signature;
      api<{ documents: CheckedDocument[] }>("/policies/imports/check", {
        method: "POST",
        body: { documents: batch.bodies },
      })
        .then((answer): CheckState => ({ status: "ok", documents: answer.documents }))
        .catch((err): CheckState => {
          const problems = detailsOf(err).problems;
          return codeOf(err) === "batch_refused" && Array.isArray(problems)
            ? { status: "refused", problems: problems as ImportProblem[] }
            : { status: "failed", text: explainError(err) };
        })
        .then((state) => setChecks((was) => ({ ...was, [signature]: state })));
    }
    // The batches are named by what they hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatures]);

  const checkAgain = (signature: string) => {
    asked.current.delete(signature);
    setChecks((was) => {
      const next = { ...was };
      delete next[signature];
      return next;
    });
  };

  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFileProblem(null);
    setSaid(null);
    if (picked.size > FILE_MAX) {
      e.target.value = "";
      return setFileProblem(m.fileProblems.tooLarge);
    }
    setReading(true);
    const text = await picked.text().catch(() => null);
    e.target.value = "";
    const read = text === null ? ({ problem: "unreadable" } as FileProblem) : readImportFile(text);
    if ("problem" in read) {
      setReading(false);
      setFile(null);
      return setFileProblem(
        read.problem === "unknownColumns"
          ? fill(m.fileProblems.unknownColumns, { columns: unitList(read.columns) })
          : m.fileProblems[read.problem],
      );
    }
    // The owners, by the names written: one person each, or chosen later.
    const names = [...new Set(read.rows.map((r) => r.fields.owner).filter(Boolean))];
    const found = new Map<string, Person[]>();
    await Promise.all(
      names.map((name) =>
        api<Person[]>(`/policies/people?${new URLSearchParams({ q: name.slice(0, 100) })}`)
          .then((people) => found.set(name, peopleNamed(people, name)))
          .catch(() => found.set(name, [])),
      ),
    );
    setFile({
      name: picked.name,
      kind: read.kind,
      rows: read.rows.map((r, i) => ({
        key: `${Date.now().toString(36)}-${i}`,
        at: r.at,
        fields: r.fields,
        ownerId: null,
        candidates: found.get(r.fields.owner) ?? [],
        left: false,
        imported: null,
      })),
    });
    setEditing(null);
    setSigning(null);
    setReading(false);
  }

  const update = (key: string, change: (row: Row) => Row) =>
    setFile((was) =>
      was ? { ...was, rows: was.rows.map((r) => (r.key === key ? change(r) : r)) } : was,
    );

  const typeName = (code: string) => {
    const type = findType(lists, code);
    return type ? inLang(type.name) : code;
  };
  const columnName = (column: string) => column;
  /** Where a row is in the file, in words: "Row 4" (CSV), "Item 3" (JSON). */
  const placeOf = (at: number) =>
    fill(file?.kind === "json" ? m.item : m.line, { line: numbers.format(at) });

  /** A problem found here, before the API could be asked. */
  const localText = (p: LocalProblem) => {
    const field = m.columns[p.field] ?? p.field;
    if (p.why === "missing") return fill(m.local.missing, { field });
    if (p.why === "ambiguous") return fill(m.local.ambiguous, { value: p.value ?? "" });
    if (p.field === "owner") return fill(m.local.ownerUnknown, { value: p.value ?? "" });
    return fill(m.local.unknown, { field, value: p.value ?? "" });
  };

  /** A problem the API found, said as it would be for the document alone. */
  const problemText = (p: ImportProblem, items: { row: Row }[]) => {
    if (p.code === "invalid_document") {
      const fields = Array.isArray(p.fields) ? (p.fields as string[]) : [];
      const columns = [...new Set(fields.map((f) => columnOfField(f) ?? f))];
      return fill(m.invalidColumns, {
        columns: unitList(
          columns.map((c) => m.columns[c as keyof typeof m.columns] ?? columnName(c)),
        ),
      });
    }
    if (p.code === "duplicate_in_batch") {
      const first = items[Number(p.sameAs)]?.row;
      return fill(m.duplicateOf, { place: first ? placeOf(first.at) : "" });
    }
    return explainError(asRefusal(p));
  };

  const imported = rows.filter((r) => r.imported);
  const left = rows.filter((r) => r.left && !r.imported);
  const finished = !!file && open.length === 0 && imported.length > 0;

  return (
    <div className="mt-4 flex max-w-4xl flex-col gap-6">
      <Panel title={m.chooseFile}>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted">{m.chooseFileHelp}</p>
          {imported.length > 0 && open.length > 0 && (
            <p className="text-sm text-warn">{m.newFileWarning}</p>
          )}
          <div>
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-line px-4 text-sm font-medium hover:bg-surface has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
              <FileUp className="size-4" aria-hidden />
              {reading ? m.reading : file ? m.chooseAnother : m.choose}
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                onChange={(e) => void choose(e)}
                disabled={reading || readOnly || closed}
                className="sr-only"
              />
            </label>
          </div>
          {fileProblem && (
            <p role="alert" className="text-sm text-danger">
              {fileProblem}
            </p>
          )}
          {file && (
            <p role="status" className="text-sm">
              <Words
                text={m.fileRead}
                values={{
                  file: <bdi dir="auto">{file.name}</bdi>,
                  count: numbers.format(rows.length),
                }}
              />
            </p>
          )}
        </div>
      </Panel>

      {file && open.length > 0 && (
        <div className="rounded-lg border border-accent bg-accent-soft px-4 py-3 text-sm">
          <p className="font-medium">
            {fill(batches.length > 1 ? m.splitInto : m.oneBatch, {
              count: numbers.format(open.length - toCorrect.length),
              batches: numbers.format(batches.length),
            })}
          </p>
          <p className="mt-1">{m.eachBatchSigned}</p>
        </div>
      )}

      {toCorrect.length > 0 && (
        <Panel title={fill(m.toCorrectTitle, { count: numbers.format(toCorrect.length) })}>
          <p className="px-4 pt-3 text-sm text-muted">{m.toCorrectHelp}</p>
          <ul>
            {toCorrect.map(({ row, problems }) => (
              <RowItem
                key={row.key}
                lang={lang}
                t={t}
                row={row}
                place={placeOf(row.at)}
                typeName={typeName}
                lines={problems.map(localText)}
                tone="danger"
                editing={editing === row.key}
                onEdit={() => setEditing(editing === row.key ? null : row.key)}
                onLeave={() => update(row.key, (r) => ({ ...r, left: true }))}
              >
                {editing === row.key && (
                  <RowEditor
                    lang={lang}
                    t={t}
                    row={row}
                    place={placeOf(row.at)}
                    lists={lists}
                    authoritative={authoritative}
                    onCancel={() => setEditing(null)}
                    onSave={(next) => {
                      update(row.key, () => next);
                      setEditing(null);
                    }}
                  />
                )}
              </RowItem>
            ))}
          </ul>
        </Panel>
      )}

      {batches.map((batch, b) => {
        const state = checks[batch.signature];
        const problems = state?.status === "refused" ? state.problems : [];
        const ok = state?.status === "ok";
        const first = batch.items[0].row.at;
        const last = batch.items[batch.items.length - 1].row.at;
        return (
          <Panel
            key={batch.signature}
            title={fill(m.batchTitleLine, {
              batch: numbers.format(signedCount + b + 1),
              batches: numbers.format(signedCount + batches.length),
            })}
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-sm">
              <span className="text-muted">
                {fill(file?.kind === "json" ? m.batchItems : m.batchLines, {
                  count: numbers.format(batch.items.length),
                  first: numbers.format(first),
                  last: numbers.format(last),
                })}
              </span>
              {!state ? (
                <Pill tone="neutral">{m.checking}</Pill>
              ) : ok ? (
                <Pill tone="ok">{m.readyToSign}</Pill>
              ) : state.status === "refused" ? (
                <Pill tone="danger">
                  {fill(m.problemsCount, { count: numbers.format(problems.length) })}
                </Pill>
              ) : (
                <Pill tone="danger">{m.checkFailed}</Pill>
              )}
              {state && !ok && (
                <Button variant="secondary" onClick={() => checkAgain(batch.signature)}>
                  {m.checkAgain}
                </Button>
              )}
            </div>
            {state?.status === "refused" && (
              <p className="px-4 pt-3 text-sm text-muted">{m.noProblemHere}</p>
            )}
            {state?.status === "failed" && (
              <p role="alert" className="px-4 pt-3 text-sm text-danger">
                {state.text}
              </p>
            )}
            <ul>
              {batch.items.map((item, i) => {
                const mine = problems.filter((p) => p.index === i);
                const checked = ok ? state.documents.find((d) => d.index === i) : undefined;
                const type = findType(lists, item.row.fields.type);
                return (
                  <RowItem
                    key={item.row.key}
                    lang={lang}
                    t={t}
                    row={item.row}
                    place={placeOf(item.row.at)}
                    typeName={typeName}
                    lines={mine.map((p) => problemText(p, batch.items))}
                    tone={mine.length > 0 ? "danger" : "neutral"}
                    editing={editing === item.row.key}
                    onEdit={
                      signing === batch.signature || mine.length === 0
                        ? undefined
                        : () => setEditing(editing === item.row.key ? null : item.row.key)
                    }
                    onLeave={
                      signing === batch.signature || mine.length === 0
                        ? undefined
                        : () => update(item.row.key, (r) => ({ ...r, left: true }))
                    }
                  >
                    {checked && (
                      <CheckedLines
                        lang={lang}
                        t={t}
                        checked={checked}
                        sections={type?.sections ?? []}
                        given={item.body?.number}
                      />
                    )}
                    {editing === item.row.key && (
                      <RowEditor
                        lang={lang}
                        t={t}
                        row={item.row}
                        place={placeOf(item.row.at)}
                        lists={lists}
                        authoritative={authoritative}
                        onCancel={() => setEditing(null)}
                        onSave={(next) => {
                          update(item.row.key, () => next);
                          setEditing(null);
                        }}
                      />
                    )}
                  </RowItem>
                );
              })}
            </ul>
            {ok && (
              <div className="border-t border-line p-4">
                {signing === batch.signature ? (
                  <PasswordPrompt
                    t={t}
                    intro={
                      <>
                        <p>
                          {fill(m.signBatch, {
                            count: numbers.format(batch.items.length),
                            batch: numbers.format(signedCount + b + 1),
                            batches: numbers.format(signedCount + batches.length),
                          })}
                        </p>
                        <NotedDifferences
                          lang={lang}
                          t={t}
                          items={batch.items.map((item) => ({
                            key: item.row.key,
                            label: (
                              <>
                                {placeOf(item.row.at)}{" "}
                                <bdi>
                                  {item.row.fields.number ||
                                    inLang(item.row.fields.title)}
                                </bdi>
                              </>
                            ),
                            differences: item.body?.differences,
                          }))}
                        />
                      </>
                    }
                    confirm={fill(m.signBatchConfirm, {
                      count: numbers.format(batch.items.length),
                    })}
                    explainError={(err) => {
                      // Refused at signing: something changed since the check.
                      if (codeOf(err) === "batch_refused") {
                        checkAgain(batch.signature);
                        return m.changedSinceCheck;
                      }
                      return explainError(err);
                    }}
                    onCancel={() => setSigning(null)}
                    submit={async (password) => {
                      const answer = await api<ImportedBatch>("/policies/imports", {
                        method: "POST",
                        body: { password, documents: batch.bodies },
                      });
                      const done = new Map(
                        answer.documents.map((d) => [batch.items[d.index]?.row.key, d]),
                      );
                      setFile((was) =>
                        was
                          ? {
                              ...was,
                              rows: was.rows.map((r) => {
                                const d = done.get(r.key);
                                return d ? { ...r, imported: { id: d.id, number: d.number } } : r;
                              }),
                            }
                          : was,
                      );
                      setSigning(null);
                      setSignedCount((n) => n + 1);
                      setSaid(
                        fill(m.batchSigned, {
                          count: numbers.format(answer.documents.length),
                        }),
                      );
                    }}
                  />
                ) : (
                  <div className="flex flex-col items-start gap-1">
                    <Button
                      disabled={readOnly || signing !== null || editing !== null}
                      onClick={() => {
                        setSaid(null);
                        setSigning(batch.signature);
                      }}
                    >
                      {fill(m.signBatchOpen, { batch: numbers.format(signedCount + b + 1) })}
                    </Button>
                    <p className="text-xs text-muted">{m.signBatchHelp}</p>
                  </div>
                )}
              </div>
            )}
          </Panel>
        );
      })}

      {said && (
        <p role="status" className="text-sm font-medium text-accent">
          {said}
        </p>
      )}

      {left.length > 0 && (
        <Panel title={fill(m.leftOutTitle, { count: numbers.format(left.length) })}>
          <ul>
            {left.map((row) => (
              <li
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 text-sm last:border-b-0"
              >
                <span>
                  <span className="text-muted">{placeOf(row.at)}</span>{" "}
                  <bdi>{inLang(row.fields.title) || row.fields.number}</bdi>
                </span>
                <Button
                  variant="secondary"
                  onClick={() => update(row.key, (r) => ({ ...r, left: false }))}
                >
                  {m.putBack}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {imported.length > 0 && (
        <Panel
          title={fill(m.importedTitle, {
            count: numbers.format(imported.length),
            batches: numbers.format(signedCount),
          })}
        >
          <ul>
            {imported.map((row) => (
              <li
                key={row.key}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-b-0"
              >
                <Link
                  href={documentPath(lang, row.imported!.id)}
                  className="font-medium text-accent hover:underline"
                >
                  <bdi dir="ltr" className="whitespace-nowrap">
                    {row.imported!.number}
                  </bdi>
                </Link>
                <bdi>{inLang(row.fields.title)}</bdi>
                <span className="text-xs text-muted">{placeOf(row.at)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {finished && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm font-medium">
            {left.length > 0
              ? fill(m.allDoneLeftOut, { count: numbers.format(left.length) })
              : m.allDone}
          </p>
          <ButtonLink href={`/${lang}/policies`}>{m.toLibrary}</ButtonLink>
          <Button
            variant="secondary"
            onClick={() => {
              setFile(null);
              setChecks({});
              asked.current.clear();
              setSignedCount(0);
              setSaid(null);
              fileInput.current?.focus();
            }}
          >
            {m.startAgain}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One row of the file: where it is, what it is, and what was found. */
function RowItem({
  lang,
  t,
  row,
  typeName,
  lines,
  tone,
  editing,
  onEdit,
  onLeave,
  place,
  children,
}: PoliciesProps & {
  row: Row;
  typeName: (code: string) => string;
  lines: string[];
  tone: "danger" | "neutral";
  editing: boolean;
  onEdit?: () => void;
  onLeave?: () => void;
  /** Where it is in the file, in words. */
  place: string;
  children?: ReactNode;
}) {
  const session = useSession();
  const m = t.importing;
  const f = row.fields;
  return (
    <li
      className={`border-b border-line py-3 pe-4 last:border-b-0 ${
        tone === "danger" ? "border-s-4 border-s-danger ps-3" : "ps-4"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-muted">{place}</span>
        {f.number && (
          <bdi dir="ltr" className="text-sm font-medium whitespace-nowrap">
            {f.number}
          </bdi>
        )}
        {f.type && <Pill tone="neutral">{typeName(f.type)}</Pill>}
      </div>
      <p className="mt-1 text-sm font-medium break-words">
        <bdi>{pick(f.title, lang, session.tenant.defaultLocale) || m.noTitle}</bdi>
      </p>
      {lines.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {lines.map((line, i) => (
            <li key={i} className="text-sm text-danger">
              {line}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex flex-col gap-2">{children}</div>
      {(onEdit || onLeave) && !editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          {onEdit && (
            <Button onClick={onEdit}>
              {m.correct}
            </Button>
          )}
          {onLeave && (
            <Button variant="secondary" onClick={onLeave}>
              {m.leaveOut}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

const joinList = (values: string[]) => values.join(" | ");
const splitList = (value: string) =>
  value
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Correcting one row, here rather than in the file: every field the file
 * gives, the owner chosen among the people of the organization.
 */
function RowEditor({
  lang,
  t,
  row,
  place,
  lists,
  authoritative,
  onSave,
  onCancel,
}: PoliciesProps & {
  row: Row;
  place: string;
  lists: Ready["lists"];
  authoritative: string;
  onSave: (row: Row) => void;
  onCancel: () => void;
}) {
  const session = useSession();
  const { defaultLocale, locales } = session.tenant;
  const inLang = (text: Localized | null | undefined) => pick(text, lang, defaultLocale);
  const m = t.importing;
  const f = row.fields;
  const [typeCode, setTypeCode] = useState(findType(lists, f.type)?.code ?? f.type);
  const [people, setPeople] = useState<Person[]>(row.candidates);
  const type = findType(lists, typeCode);
  const ownerNow =
    row.ownerId ?? (row.candidates.length === 1 ? row.candidates[0].id : "");
  // Nobody of that name: everyone is offered, to be narrowed by a search.
  useEffect(() => {
    if (row.candidates.length > 0) return;
    let current = true;
    api<Person[]>("/policies/people")
      .then((found) => current && setPeople(found))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [row.candidates.length]);

  async function findPeople(q: string) {
    try {
      const found = await api<Person[]>(
        `/policies/people${q.trim() ? `?${new URLSearchParams({ q: q.trim().slice(0, 100) })}` : ""}`,
      );
      setPeople(found);
    } catch {
      // The list shown stays as it was.
    }
  }
  const owners = [...people];
  if (!owners.some((p) => p.id === session.user.id)) {
    owners.push({ id: session.user.id, name: session.user.name, orgUnitId: session.user.orgUnitId });
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const fields = readForm(form);
    const localized = (value: unknown): Localized =>
      Object.fromEntries(
        Object.entries((value ?? {}) as Record<string, unknown>)
          .map(([k, v]) => [k, String(v ?? "").trim()])
          .filter(([, v]) => v),
      );
    const content = readSections(form);
    const sections: Record<string, Localized> = {};
    for (const [locale, byKey] of Object.entries(content)) {
      for (const [key, value] of Object.entries(byKey)) {
        sections[key] = { ...sections[key], [locale]: value };
      }
    }
    const ownerId = text("ownerId");
    const owner = owners.find((p) => p.id === ownerId);
    onSave({
      ...row,
      ownerId: ownerId || null,
      candidates: owner ? [owner] : row.candidates,
      fields: {
        ...f,
        number: text("number"),
        revision: text("revisionLabel"),
        type: typeCode,
        category: text("category"),
        area: text("area"),
        owner: owner ? inLang(owner.name) : f.owner,
        approvedOn: text("approvedOn"),
        approvedBy: text("approvedBy"),
        lastReviewedOn: text("lastReviewedOn"),
        effectiveOn: text("effectiveOn"),
        nextReviewOn: text("nextReviewOn"),
        reviewMonths: text("reviewMonths"),
        confidentiality: text("confidentiality"),
        appliesTo: splitList(text("appliesTo")),
        roles: splitList(text("roles")),
        keywords: splitList(text("keywords")),
        references: splitList(text("references")),
        acknowledge: data.get("acknowledge") ? "yes" : "no",
        acknowledgeDays: text("acknowledgeDays"),
        title: localized(fields.title),
        keptAt: localized(fields.keptAt),
        differences: localized(fields.differences),
        sections,
      },
    });
  }

  const ack = ["yes", "true", "1"].includes(f.acknowledge.trim().toLowerCase());
  return (
    <form
      onSubmit={save}
      className="mt-2 flex flex-col gap-5 rounded-lg border border-line bg-surface p-4"
    >
      <p className="text-sm font-medium">{fill(m.correcting, { place })}</p>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={m.columns.type}>
          <select
            name="type"
            required
            value={type?.code ?? ""}
            onChange={(e) => setTypeCode(e.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              {t.form.choose}
            </option>
            {lists.types.map((x) => (
              <option key={x.id} value={x.code}>
                {inLang(x.name)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={m.columns.category}>
          <select
            name="category"
            required
            defaultValue={lists.categories.find((c) => c.code.toLowerCase() === f.category.toLowerCase())?.code ?? ""}
            className={inputClass}
          >
            <option value="" disabled>
              {t.form.choose}
            </option>
            {lists.categories.map((c) => (
              <option key={c.id} value={c.code}>
                {inLang(c.name)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={m.columns.area}>
          <select
            name="area"
            required
            defaultValue={lists.units.find((u) => u.code.toLowerCase() === f.area.toLowerCase())?.code ?? ""}
            className={inputClass}
          >
            <option value="" disabled>
              {t.form.choose}
            </option>
            {lists.units
              .filter((u) => u.active)
              .map((u) => (
                <option key={u.id} value={u.code}>
                  {inLang(u.name)}
                </option>
              ))}
          </select>
        </Field>
        <div className="flex flex-col gap-2">
          <Field label={t.form.ownerSearch} help={f.owner ? fill(m.ownerInFile, { name: f.owner }) : undefined}>
            <input
              type="search"
              dir="auto"
              maxLength={100}
              autoComplete="off"
              onChange={(e) => void findPeople(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={m.columns.owner}>
            <select name="ownerId" required defaultValue={ownerNow} className={inputClass}>
              <option value="" disabled>
                {t.form.choose}
              </option>
              {owners.map((p) => (
                <option key={p.id} value={p.id}>
                  {inLang(p.name)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <LocalizedField
        label={t.form.title}
        name="title"
        locales={locales}
        required={defaultLocale}
        value={f.title}
        maxLength={300}
      />
      <OriginalFields
        t={t}
        value={{
          number: f.number,
          revision: f.revision,
          approvedOn: f.approvedOn,
          approvedBy: f.approvedBy,
          lastReviewedOn: f.lastReviewedOn,
          effectiveOn: f.effectiveOn,
          nextReviewOn: f.nextReviewOn,
          keptAt: f.keptAt,
          differences: f.differences,
        }}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={m.columns.reviewMonths} help={m.reviewMonthsHelp}>
          <input
            name="reviewMonths"
            type="number"
            min={1}
            max={lists.maxReviewMonths ?? 120}
            inputMode="numeric"
            dir="ltr"
            defaultValue={f.reviewMonths}
            className={inputClass}
          />
        </Field>
        <Field label={m.columns.confidentiality}>
          <select
            name="confidentiality"
            defaultValue={f.confidentiality === "restricted" ? "restricted" : "all_staff"}
            className={inputClass}
          >
            {(["all_staff", "restricted"] as const).map((v) => (
              <option key={v} value={v}>
                {t.confidentiality[v]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={m.columns.appliesTo} help={m.appliesToHelp}>
          <input name="appliesTo" dir="ltr" defaultValue={joinList(f.appliesTo)} className={inputClass} />
        </Field>
        <Field label={m.columns.roles} help={m.rolesHelp}>
          <input name="roles" dir="ltr" defaultValue={joinList(f.roles)} className={inputClass} />
        </Field>
        <Field label={m.columns.keywords} help={m.listHelp}>
          <input name="keywords" dir="auto" defaultValue={joinList(f.keywords)} className={inputClass} />
        </Field>
        <Field label={m.columns.references} help={m.listHelp}>
          <input name="references" dir="auto" defaultValue={joinList(f.references)} className={inputClass} />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-5">
        <label className="flex min-h-10 items-center gap-3 text-sm">
          <input
            type="checkbox"
            name="acknowledge"
            defaultChecked={ack}
            className="size-4 accent-accent"
          />
          {t.editor.ackRequired}
        </label>
        <div className="max-w-56">
          <Field label={t.editor.ackDays}>
            <input
              name="acknowledgeDays"
              type="number"
              min={1}
              max={365}
              inputMode="numeric"
              dir="ltr"
              defaultValue={f.acknowledgeDays}
              className={inputClass}
            />
          </Field>
        </div>
      </div>
      {type ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{m.text}</p>
          <p className="text-xs text-muted">
            {fill(m.textHelp, { language: languageNameIn(lang)(authoritative) })}
          </p>
          <SectionsFields
            lang={lang}
            t={t}
            sections={type.sections}
            authoritative={authoritative}
            value={f.sections}
          />
        </div>
      ) : (
        <p className="text-sm text-muted">{m.chooseTypeFirst}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{m.saveCorrection}</Button>
        <Button variant="secondary" onClick={onCancel}>
          {t.actions.cancel}
        </Button>
      </div>
    </form>
  );
}
