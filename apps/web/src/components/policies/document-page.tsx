"use client";

import { Printer } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import {
  dateTimeFormat,
  dayFormat,
  durationFormat,
  fill,
  numberFormat,
} from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  documentPath,
  shownLanguage,
  versionPath,
  type DocumentChange,
  type DocumentVersion,
  type History,
  type Named,
  type PolicyDocument,
} from "@/lib/policies";
import { ControlledDocument, LanguageSwitch } from "./controlled-document";
import { PasswordPrompt } from "./password-prompt";
import {
  DocumentStatusPill,
  RestrictedPill,
  ReviewPill,
  VersionStatusPill,
} from "./pills";
import { isStale, textareaClass, type PoliciesProps } from "./types";
import { Sentence, Words } from "./sentence";
import { useExplain } from "./use-explain";

type Loaded = {
  doc: PolicyDocument;
  history: History | null;
  published: DocumentVersion | null;
  inProgress: DocumentVersion | null;
};

/** Reads a document with its published version, its history and what is in progress. */
export async function loadDocument(id: string): Promise<Loaded> {
  const doc = await api<PolicyDocument>(`/policies/documents/${id}`);
  const [history, published, inProgress] = await Promise.all([
    api<History>(`/policies/documents/${id}/versions`).catch(() => null),
    doc.published
      ? api<DocumentVersion>(
          `/policies/documents/${id}/versions/${doc.published.id}`,
        )
      : null,
    doc.inProgress
      ? api<DocumentVersion>(
          `/policies/documents/${id}/versions/${doc.inProgress.id}`,
        ).catch(() => null)
      : null,
  ]);
  return { doc, history, published, inProgress };
}

/**
 * One document: its published version laid out as a controlled document,
 * the language it is read in, what is in progress, its history, and what
 * the API lets this reader do with it now.
 */
export function DocumentPage({ lang, t }: PoliciesProps) {
  const { id } = useParams<{ id: string }>();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [behind, setBehind] = useState(false);

  useEffect(() => {
    let current = true;
    loadDocument(id)
      .then((next) => {
        if (!current) return;
        setLoaded(next);
        setProblem(null);
        setBehind(false);
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

  const refresh = useCallback(
    () =>
      loadDocument(id)
        .then((next) => {
          setLoaded(next);
          setBehind(false);
        })
        .catch((err) =>
          statusOf(err) === 404 ? setProblem(t.notFound) : setBehind(true),
        ),
    [id, t],
  );

  const shown = loaded?.doc.id === id ? loaded : null;
  if (problem || !shown) {
    return (
      <>
        <EmptyState>{problem ?? t.loading}</EmptyState>
        {problem && (
          <p className="text-center text-sm">
            <Link href={`/${lang}/policies`} className="text-accent hover:underline">
              {t.back}
            </Link>
          </p>
        )}
      </>
    );
  }
  // Keyed by the document, so the language chosen and anything typed on
  // another document does not carry over.
  return (
    <DocumentView
      key={shown.doc.id}
      lang={lang}
      t={t}
      loaded={shown}
      behind={behind}
      refresh={refresh}
    />
  );
}

function DocumentView({
  lang,
  t,
  loaded,
  behind,
  refresh,
}: PoliciesProps & {
  loaded: Loaded;
  behind: boolean;
  refresh: () => Promise<void>;
}) {
  const session = useSession();
  const { doc, history, published, inProgress } = loaded;
  const [asked, setAsked] = useState<string | null>(null);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const name = (person: Named | null | undefined) =>
    (person && inLang(person.name)) || t.document.unknownPerson;
  const day = dayFormat(lang);
  const numbers = numberFormat(lang);
  const d = t.document;
  const shownIn = published
    ? shownLanguage(published.languages, asked, lang)
    : null;

  return (
    <>
      <PageHeader
        title={<bdi>{inLang(doc.title)}</bdi>}
        description={
          <>
            <bdi dir="ltr" className="whitespace-nowrap">
              {doc.number}
            </bdi>{" "}
            <span className="inline-block">
              {"· "}
              <bdi>{inLang(doc.type.name)}</bdi>
            </span>{" "}
            <span className="inline-block">
              {"· "}
              <bdi>{inLang(doc.ownerUnit.name)}</bdi>
            </span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <DocumentStatusPill t={t} status={doc.status} />
            <ReviewPill t={t} review={doc.review} />
            {doc.confidentiality === "restricted" && <RestrictedPill t={t} />}
          </div>
        }
      />

      {behind && (
        <p
          role="status"
          className="mt-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger print:hidden"
        >
          {t.behind}
        </p>
      )}

      {doc.status === "retired" && (
        <div className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm">
          <p className="font-medium">
            {fill(d.retiredOn, {
              date: doc.retiredAt
                ? dateTimeFormat(lang, session.tenant.timeZone).format(
                    new Date(doc.retiredAt),
                  )
                : "",
            })}
          </p>
          {doc.retiredBy && (
            <p className="mt-1">{fill(d.retiredBy, { name: name(doc.retiredBy) })}</p>
          )}
          {doc.retireReason && (
            <p dir="auto" className="mt-1 whitespace-pre-line text-muted">
              {doc.retireReason}
            </p>
          )}
        </div>
      )}

      {doc.inProgress && (
        <InProgress lang={lang} t={t} doc={doc} version={inProgress} />
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] print:block">
        <div className="flex min-w-0 flex-col gap-6">
          {published ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
                <LanguageSwitch
                  t={t}
                  languages={published.languages}
                  shown={shownIn ?? ""}
                  onChange={setAsked}
                />
                <ButtonLink
                  variant="secondary"
                  href={`/${lang}/policies/${doc.id}/print?${new URLSearchParams({
                    version: published.id,
                    ...(shownIn ? { in: shownIn } : {}),
                  })}`}
                >
                  <Printer className="size-4" aria-hidden />
                  {d.print}
                </ButtonLink>
              </div>
              <ControlledDocument
                lang={lang}
                t={t}
                document={doc}
                version={published}
                shown={shownIn}
              />
              {(published.moves.includes("acknowledge") ||
                published.myAcknowledgement?.acknowledgedAt) && (
                <Acknowledge
                  lang={lang}
                  t={t}
                  doc={doc}
                  version={published}
                  onDone={refresh}
                />
              )}
            </>
          ) : (
            <Panel>
              <EmptyState>{d.notPublished}</EmptyState>
            </Panel>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6 print:hidden">
          {doc.moves.length > 0 && (
            <DocumentActions lang={lang} t={t} doc={doc} onDone={refresh} />
          )}
          <Details lang={lang} t={t} doc={doc} />
          {doc.access === "full" && published?.acknowledgementRequired && (
            <Panel title={d.acknowledgements}>
              <p className="px-4 pt-3 text-sm text-muted">
                {d.acknowledgementsHelp}
              </p>
              <p className="px-4 py-3 text-sm">
                <Link
                  href={`/${lang}/policies/${doc.id}/acknowledgements`}
                  className="text-accent hover:underline"
                >
                  {d.openAcknowledgements}
                </Link>
              </p>
            </Panel>
          )}
        </div>
      </div>

      {history && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2 print:hidden">
          <Panel title={d.history}>
            {history.versions.length === 0 ? (
              <EmptyState>{d.noHistory}</EmptyState>
            ) : (
              <ul>
                {history.versions.map((v) => (
                  <li
                    key={v.id}
                    className="border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Link
                        href={versionPath(lang, doc.id, v.id)}
                        className="font-medium text-accent hover:underline"
                      >
                        {fill(t.versionNumber, {
                          version: numbers.format(v.version),
                        })}
                      </Link>
                      <VersionStatusPill t={t} status={v.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {v.publishedAt
                        ? fill(d.effectiveFrom, {
                            date: day(v.effectiveOn) ?? "",
                          })
                        : v.preparedAt
                          ? fill(d.preparedOn, {
                              date: dateTimeFormat(lang, session.tenant.timeZone).format(
                                new Date(v.preparedAt),
                              ),
                            })
                          : ""}
                    </p>
                    {v.changeSummary && (
                      <p dir="auto" className="mt-1 text-sm whitespace-pre-line">
                        {inLang(v.changeSummary)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {doc.access === "full" && (
            <Panel title={d.reviews}>
              {history.reviews.length === 0 ? (
                <EmptyState>{d.noReviews}</EmptyState>
              ) : (
                <ul>
                  {history.reviews.map((r) => (
                    <li
                      key={r.id}
                      className="border-b border-line px-4 py-3 text-sm last:border-b-0"
                    >
                      <p className="font-medium">
                        {Object.hasOwn(d.outcome, r.outcome)
                          ? d.outcome[r.outcome as keyof typeof d.outcome]
                          : d.outcome.other}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {fill(d.reviewedOnBy, {
                          name: name(r.reviewedBy),
                          date: r.reviewedAt
                            ? dateTimeFormat(lang, session.tenant.timeZone).format(
                                new Date(r.reviewedAt),
                              )
                            : "",
                        })}
                      </p>
                      {r.nextReviewOn && (
                        <p className="mt-1 text-xs text-muted">
                          {fill(d.nextReviewSet, {
                            date: day(r.nextReviewOn) ?? "",
                          })}
                        </p>
                      )}
                      {r.comment && (
                        <p dir="auto" className="mt-1 whitespace-pre-line">
                          {r.comment}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </div>
      )}

      {doc.access === "full" && (
        <div className="mt-6 print:hidden">
          {/* Read again from its first page whenever the details change. */}
          <DetailChanges key={doc.revision} lang={lang} t={t} documentId={doc.id} />
        </div>
      )}

      <p className="mt-6 text-sm print:hidden">
        <Link href={`/${lang}/policies`} className="text-accent hover:underline">
          {t.back}
        </Link>
      </p>
    </>
  );
}

const CHANGES_PAGE = 10;

/**
 * What was changed in the document's details since it was created, newest
 * first, a page at a time: by whom, when, why (a change of review period
 * always says why), and each field from what to what. For those with full
 * sight of the document.
 */
function DetailChanges({
  lang,
  t,
  documentId,
}: PoliciesProps & { documentId: string }) {
  const session = useSession();
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<{
    page: number;
    items: DocumentChange[];
    total: number;
  } | null>(null);
  const [failed, setFailed] = useState<{ page: number; text: string } | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    api<{ items: DocumentChange[]; total: number }>(
      `/policies/documents/${documentId}/changes?${new URLSearchParams({
        page: String(page),
        pageSize: String(CHANGES_PAGE),
      })}`,
    )
      .then((r) => current && setAnswer({ page, ...r }))
      .catch(
        (err) =>
          current &&
          setFailed({
            page,
            text: statusOf(err) === 403 ? t.errors.missing_permission : t.loadError,
          }),
      );
    return () => {
      current = false;
    };
  }, [documentId, page, t]);
  const here = answer?.page === page ? answer : null;
  const problem = !here && failed?.page === page ? failed.text : null;
  const changes = here?.items ?? [];
  const pages = here ? Math.max(1, Math.ceil(here.total / CHANGES_PAGE)) : 1;
  const numbers = numberFormat(lang);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const day = dayFormat(lang);
  const months = durationFormat(lang);
  const d = t.document;
  const labels: Record<string, string> = {
    title: t.form.title,
    category: d.category,
    owner: d.owner,
    ownerUnit: d.ownerUnit,
    audience: d.appliesTo,
    confidentiality: d.confidentialityLabel,
    reviewMonths: d.reviewPeriod,
    nextReviewOn: d.nextReviewOn,
    keywords: d.keywords,
    references: d.references,
  };
  const named = (value: unknown) =>
    value && typeof value === "object" && "name" in value
      ? inLang((value as { name: Localized | null }).name)
      : "";
  const shown = (field: string, value: unknown): string => {
    if (value === null || value === undefined || value === "") return d.none;
    switch (field) {
      case "title":
        return inLang(value as Localized) || d.none;
      case "category":
      case "ownerUnit":
        return named(value) || d.none;
      case "owner":
        return named(value) || d.unknownPerson;
      case "audience": {
        const a = value as {
          wholeOrganization?: boolean;
          orgUnits?: { name: Localized | null }[];
          roles?: { name: Localized | null }[];
        };
        const where = a.wholeOrganization
          ? d.wholeOrganization
          : (a.orgUnits ?? []).map((u) => inLang(u.name)).join(" · ");
        const roles = (a.roles ?? []).map((r) => inLang(r.name)).join(" · ");
        return roles ? `${where} (${roles})` : where;
      }
      case "confidentiality":
        return Object.hasOwn(t.confidentiality, String(value))
          ? t.confidentiality[value as keyof typeof t.confidentiality]
          : String(value);
      case "reviewMonths":
        return typeof value === "number" ? months(value, "month") : String(value);
      case "nextReviewOn":
        return day(String(value)) ?? String(value);
      case "keywords":
      case "references":
        return Array.isArray(value) && value.length > 0
          ? value.join(", ")
          : d.none;
      default:
        return typeof value === "string" ? value : d.none;
    }
  };
  return (
    <Panel title={d.changesTitle}>
      {problem ? (
        <EmptyState>{problem}</EmptyState>
      ) : !here ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : changes.length === 0 ? (
        <EmptyState>{d.noChanges}</EmptyState>
      ) : (
        <ul>
          {changes.map((entry) => (
            <li
              key={entry.id}
              className="border-b border-line px-4 py-3 text-sm last:border-b-0"
            >
              <p className="text-xs text-muted">
                {fill(d.reviewedOnBy, {
                  name: inLang(entry.by?.name) || d.unknownPerson,
                  date: moments.format(new Date(entry.at)),
                })}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {entry.changes.map((c) => (
                  <li key={c.field} className="break-words">
                    <Words
                      text={d.changeLine}
                      values={{
                        field: labels[c.field] ?? d.otherDetail,
                        from: <bdi className="text-muted">{shown(c.field, c.from)}</bdi>,
                        to: <bdi className="font-medium">{shown(c.field, c.to)}</bdi>,
                      }}
                    />
                  </li>
                ))}
              </ul>
              {entry.reason && (
                <p className="mt-1">
                  <span className="text-muted">{d.changeReason}</span>{" "}
                  <bdi dir="auto" className="whitespace-pre-line">
                    {entry.reason}
                  </bdi>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {here && pages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-sm text-muted">
          <span>
            {fill(t.list.page, {
              page: numbers.format(page),
              pages: numbers.format(pages),
            })}
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {t.list.previous}
            </Button>
            <Button
              variant="secondary"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              {t.list.next}
            </Button>
          </span>
        </div>
      )}
    </Panel>
  );
}

/** The version being prepared or reviewed, for those who may see it. */
function InProgress({
  lang,
  t,
  doc,
  version,
}: PoliciesProps & { doc: PolicyDocument; version: DocumentVersion | null }) {
  const numbers = numberFormat(lang);
  const progress = doc.inProgress!;
  const mine = version?.moves.includes("approve") && version.myStep;
  const editable = version?.moves.includes("edit");
  return (
    <div
      className={`mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm print:hidden ${
        mine ? "border-accent bg-accent-soft" : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {fill(t.versionNumber, { version: numbers.format(progress.version) })}
          <VersionStatusPill t={t} status={progress.status} />
        </p>
        {mine && version?.myStep && (
          <p>
            {version.myStep.kind === "review"
              ? t.document.waitingForYourReview
              : t.document.waitingForYourApproval}
          </p>
        )}
        {version?.myStep?.samePerson && (
          <p className="text-muted">{t.review.samePerson}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {editable && (
          <ButtonLink href={`${versionPath(lang, doc.id, progress.id)}/edit`}>
            {t.document.openEditor}
          </ButtonLink>
        )}
        <ButtonLink
          variant={editable ? "secondary" : "primary"}
          href={versionPath(lang, doc.id, progress.id)}
        >
          {mine ? t.document.openReview : t.document.openVersion}
        </ButtonLink>
      </div>
    </div>
  );
}

function Details({ lang, t, doc }: PoliciesProps & { doc: PolicyDocument }) {
  const session = useSession();
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const day = dayFormat(lang);
  const d = t.document;
  const audience = doc.audience.wholeOrganization
    ? d.wholeOrganization
    : doc.audience.orgUnits.map((u) => inLang(u.name)).join(" · ");
  const rows: [string, ReactNode][] = [
    [d.category, <bdi key="c">{inLang(doc.category.name)}</bdi>],
    [d.owner, <bdi key="o">{inLang(doc.owner.name) || d.unknownPerson}</bdi>],
    [d.appliesTo, <bdi key="a">{audience}</bdi>],
  ];
  if (doc.audience.roles.length > 0) {
    rows.push([
      d.rolesOnly,
      <bdi key="r">{doc.audience.roles.map((r) => inLang(r.name)).join(" · ")}</bdi>,
    ]);
  }
  rows.push([d.confidentialityLabel, t.confidentiality[doc.confidentiality]]);
  rows.push([
    d.reviewPeriod,
    durationFormat(lang)(doc.reviewMonths, "month"),
  ]);
  if (doc.lastReviewedOn) {
    rows.push([d.lastReviewedOn, day(doc.lastReviewedOn) ?? ""]);
  }
  if (doc.nextReviewOn && doc.status === "active") {
    rows.push([d.nextReviewOn, day(doc.nextReviewOn) ?? ""]);
  }
  return (
    <Panel title={d.details}>
      <dl className="flex flex-col gap-3 px-4 py-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-0.5 break-words">{value}</dd>
          </div>
        ))}
        {doc.keywords.length > 0 && (
          <div>
            <dt className="text-xs text-muted">{d.keywords}</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {doc.keywords.map((k) => (
                <Pill key={k} tone="neutral">
                  <bdi>{k}</bdi>
                </Pill>
              ))}
            </dd>
          </div>
        )}
        {doc.references.length > 0 && (
          <div>
            <dt className="text-xs text-muted">{d.references}</dt>
            <dd className="mt-1">
              <ul className="flex flex-col gap-0.5">
                {doc.references.map((r) => (
                  <li key={r} dir="auto">
                    {r}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </Panel>
  );
}

/**
 * "I have read and understood": a tick, then the password. Offered under
 * the text, so it is given after the document has been opened. It stays
 * open while the subscription is suspended.
 */
function Acknowledge({
  lang,
  t,
  doc,
  version,
  onDone,
}: PoliciesProps & {
  doc: PolicyDocument;
  version: DocumentVersion;
  onDone: () => Promise<void>;
}) {
  const session = useSession();
  const explainError = useExplain(t, lang);
  const [done, setDone] = useState<string | null>(null);
  const a = t.acknowledge;
  const mine = version.myAcknowledgement;
  const day = dayFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  useLayoutEffect(() => () => setDone(null), []);

  const given = done ?? mine?.acknowledgedAt ?? null;
  return (
    <section
      aria-label={a.title}
      className="flex flex-col gap-3 rounded-lg border border-accent p-4 print:hidden"
    >
      <h2 className="text-base font-semibold">{a.title}</h2>
      {given ? (
        <p role="status" className="text-sm">
          {fill(a.given, { date: moments.format(new Date(given)) })}
        </p>
      ) : (
        <>
          {mine?.dueOn && (
            <p className={`text-sm ${mine.overdue ? "font-medium text-danger" : ""}`}>
              {fill(mine.overdue ? a.wasDue : a.due, {
                date: day(mine.dueOn) ?? "",
              })}
            </p>
          )}
          <PasswordPrompt
            t={t}
            intro={
              <Sentence
                text={a.intro}
                number={doc.number}
                values={{ version: numberFormat(lang).format(version.version) }}
              />
            }
            confirm={a.confirm}
            explainError={explainError}
            submit={async (password) => {
              const result = await api<{ acknowledgedAt: string }>(
                `/policies/documents/${doc.id}/versions/${version.id}/acknowledge`,
                { method: "POST", body: { password } },
              );
              setDone(result.acknowledgedAt);
              void onDone();
            }}
          >
            <label className="flex items-start gap-3 text-sm font-medium">
              <input
                type="checkbox"
                name="understood"
                required
                className="mt-0.5 size-5 shrink-0 accent-accent"
              />
              {a.understood}
            </label>
          </PasswordPrompt>
        </>
      )}
    </section>
  );
}

/** What a manager or the owner may do with the document now: the API's `moves`. */
function DocumentActions({
  lang,
  t,
  doc,
  onDone,
}: PoliciesProps & { doc: PolicyDocument; onDone: () => Promise<void> }) {
  const router = useRouter();
  const explainError = useExplain(t, lang);
  const [open, setOpen] = useState<"review" | "retire" | null>(null);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const x = t.actions;
  useLayoutEffect(
    () => () => {
      setOpen(null);
      setConfirmRetire(false);
      setMessage(null);
    },
    [],
  );

  const fail = async (err: unknown) => {
    setMessage({ ok: false, text: explainError(err) });
    if (isStale(err)) await onDone();
  };

  async function newVersion() {
    setBusy(true);
    setMessage(null);
    try {
      const version = await api<DocumentVersion>(
        `/policies/documents/${doc.id}/versions`,
        { method: "POST", body: {} },
      );
      router.push(`${versionPath(lang, doc.id, version.id)}/edit`);
    } catch (err) {
      await fail(err);
    }
    setBusy(false);
  }

  async function retire(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!confirmRetire) return setConfirmRetire(true);
    const form = e.currentTarget;
    const reason = String(new FormData(form).get("reason") ?? "").trim();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/policies/documents/${doc.id}/retire`, {
        method: "POST",
        body: { reason, revision: doc.revision },
      });
      form.reset();
      setOpen(null);
      setConfirmRetire(false);
      setMessage({ ok: true, text: x.retired });
      await onDone();
    } catch (err) {
      setConfirmRetire(false);
      await fail(err);
    }
    setBusy(false);
  }

  return (
    <Panel title={x.title}>
      {/* The API offers only what stays open while the account is
          suspended (publish, retire, acknowledge): no fieldset turns it off. */}
      <>
        <div className="flex flex-col gap-3 p-4">
          {doc.moves.includes("confirm_review") && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{x.periodicReview}</p>
              <p className="text-sm text-muted">
                {doc.moves.includes("retire")
                  ? x.periodicReviewHelp
                  : x.periodicReviewOwnerHelp}
              </p>
              {open === "review" ? (
                <PasswordPrompt
                  t={t}
                  intro={
                    <Sentence text={x.confirmReviewIntro} number={doc.number} />
                  }
                  confirm={x.confirmReview}
                  comment={{
                    label: x.reviewComment,
                    help: x.reviewCommentHelp,
                    required: true,
                  }}
                  explainError={explainError}
                  onCancel={() => setOpen(null)}
                  submit={async (password, comment) => {
                    try {
                      await api(`/policies/documents/${doc.id}/review`, {
                        method: "POST",
                        body: {
                          password,
                          revision: doc.revision,
                          comment: comment.trim(),
                        },
                      });
                    } catch (err) {
                      if (isStale(err)) void onDone();
                      throw err;
                    }
                    setOpen(null);
                    setMessage({ ok: true, text: x.reviewConfirmed });
                    await onDone();
                  }}
                />
              ) : (
                <div>
                  <Button variant="secondary" onClick={() => setOpen("review")}>
                    {x.confirmReview}
                  </Button>
                </div>
              )}
            </div>
          )}

          {doc.moves.includes("edit") && (
            <div>
              <ButtonLink variant="secondary" href={`${documentPath(lang, doc.id)}/edit`}>
                {x.editDetails}
              </ButtonLink>
            </div>
          )}

          {doc.moves.includes("new_version") && (
            <div className="flex flex-col gap-1">
              <div>
                <Button variant="secondary" disabled={busy} onClick={newVersion}>
                  {x.newVersion}
                </Button>
              </div>
              <p className="text-xs text-muted">{x.newVersionHelp}</p>
            </div>
          )}

          {doc.moves.includes("retire") &&
            (open === "retire" ? (
              <form onSubmit={retire} className="flex flex-col gap-3">
                <Field label={x.retireReason} help={x.retireHelp}>
                  <textarea
                    name="reason"
                    required
                    rows={3}
                    maxLength={1000}
                    dir="auto"
                    className={textareaClass}
                    onChange={() => setConfirmRetire(false)}
                  />
                </Field>
                {confirmRetire && (
                  <p role="alert" className="text-sm font-medium text-danger">
                    <Sentence text={x.retireConfirm} number={doc.number} />
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={busy}
                    className={confirmRetire ? "bg-danger hover:bg-danger" : ""}
                  >
                    {confirmRetire ? x.retireYes : x.retire}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setOpen(null);
                      setConfirmRetire(false);
                    }}
                  >
                    {x.keep}
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                <Button variant="secondary" onClick={() => setOpen("retire")}>
                  {x.retire}
                </Button>
              </div>
            ))}

          {message && (
            <p
              role={message.ok ? "status" : "alert"}
              className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}
            >
              {message.text}
            </p>
          )}
        </div>
      </>
    </Panel>
  );
}
