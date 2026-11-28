"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, download, statusOf } from "@/lib/api";
import {
  auditActionsByArea,
  auditApiQuery,
  auditAreas,
  auditEntityTypes,
  auditQueryString,
  readAuditQuery,
  type AuditArea,
  type AuditEntry,
  type AuditPage,
  type AuditQuery,
  type AuditStatus,
} from "@/lib/audit";
import { dateTimeFormat, dayFormat, fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { Words } from "@/components/policies/sentence";
import type { AuditText } from "./types";

const PAGE_SIZE = 50;

/** The areas of a module the client does not have are not offered. */
const areaModule: Partial<Record<AuditArea, "incidents" | "policies">> = {
  incidents: "incidents",
  documents: "policies",
  exports: "policies",
};

/** Where a record of each kind is opened, when the reader may open it. */
const recordPath = (lang: string, type: string, id: string) =>
  type === "incident"
    ? `/${lang}/incidents/${id}`
    : type === "document"
      ? `/${lang}/policies/${id}`
      : type === "user"
        ? `/${lang}/admin/users/${id}`
        : type === "role"
          ? `/${lang}/admin/roles/${id}`
          : type === "org_unit"
            ? `/${lang}/admin/organization/${id}`
            : null;

/**
 * The client's audit trail, newest first, as it was recorded: filtered by
 * record, person, action, area and days, all in the address; with where
 * the chain stands, and the files a surveyor checks it with. Nothing here
 * changes anything.
 */
export function AuditViewer({ lang, t }: { lang: string; t: AuditText }) {
  const session = useSession();
  const allowed = session.scope?.["audit.view"] === "all";
  const asked = readAuditQuery(useSearchParams());
  const query = auditQueryString(asked);
  const [answer, setAnswer] = useState<{ query: string; page: AuditPage } | null>(null);
  const [failed, setFailed] = useState<{ query: string; text: string } | null>(null);
  // The cursors of the pages before this one, to go back to the newer ones.
  const [newer, setNewer] = useState<string[]>([]);

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    const q = auditApiQuery(asked);
    q.set("pageSize", String(PAGE_SIZE));
    if (asked.before) q.set("before", asked.before);
    api<AuditPage>(`/audit/entries?${q}`).then(
      (page) => {
        if (current) setAnswer({ query, page });
      },
      (err) => {
        if (!current) return;
        const status = statusOf(err);
        setFailed({
          query,
          text: status === 403 ? t.noAccess : status === 400 ? t.invalid : t.loadError,
        });
      },
    );
    return () => {
      current = false;
    };
    // `asked` is read from `query`, which says all of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, query, t]);

  const go = (next: Partial<AuditQuery>, keepNewer = false) => {
    if (!keepNewer) setNewer([]);
    const q = auditQueryString({ ...asked, before: "", ...next });
    window.history.pushState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
  };

  const page = answer?.query === query ? answer.page : null;
  const problem = !page && failed?.query === query ? failed.text : null;
  const filtered = Object.entries(asked).some(([k, v]) => k !== "before" && v);

  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      {!allowed ? (
        <div className="mt-6">
          <Panel>
            <EmptyState>{t.noAccess}</EmptyState>
          </Panel>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <ChainStatus lang={lang} t={t} />
          <Filters lang={lang} t={t} asked={asked} page={page} onApply={(q) => go(q)} />
          <Panel>
            {problem ? (
              <EmptyState>{problem}</EmptyState>
            ) : !page ? (
              <EmptyState>{t.loading}</EmptyState>
            ) : page.items.length === 0 ? (
              <EmptyState>{filtered ? t.emptyFiltered : t.empty}</EmptyState>
            ) : (
              <>
                <p className="border-b border-line px-4 py-2 text-sm text-muted">
                  {fill(page.totalCapped ? t.list.totalCapped : t.list.total, {
                    total: numberFormat(lang).format(page.total),
                  })}
                </p>
                <ul aria-label={t.list.label}>
                  {page.items.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      lang={lang}
                      t={t}
                      entry={entry}
                      onPerson={(actorId) => go({ actorId })}
                      onRecord={(entityType, entityId) =>
                        go({ entityType, entityId, reference: "" })
                      }
                    />
                  ))}
                </ul>
                {(page.more || asked.before) && (
                  <div className="flex flex-wrap justify-between gap-2 border-t border-line px-4 py-3">
                    <span className="flex flex-wrap gap-2">
                      {asked.before && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              const back = newer.slice(0, -1);
                              const to = newer.at(-1) ?? "";
                              setNewer(back);
                              go({ before: to }, true);
                            }}
                          >
                            {t.list.newer}
                          </Button>
                          <Button variant="secondary" onClick={() => go({ before: "" })}>
                            {t.list.newest}
                          </Button>
                        </>
                      )}
                    </span>
                    {page.more && page.next && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setNewer([...newer, asked.before]);
                          go({ before: page.next ?? "" }, true);
                        }}
                      >
                        {t.list.older}
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </Panel>
          <Downloads lang={lang} t={t} asked={asked} />
        </div>
      )}
    </>
  );
}

/** One entry: when, who, what, about which record, what it recorded. */
function EntryRow({
  lang,
  t,
  entry,
  onPerson,
  onRecord,
}: {
  lang: string;
  t: AuditText;
  entry: AuditEntry;
  onPerson: (id: string) => void;
  onRecord: (type: string, id: string) => void;
}) {
  const session = useSession();
  const { defaultLocale, timeZone } = session.tenant;
  const inLang = (text: Localized | null | undefined) => pick(text, lang, defaultLocale);
  // When, on the organization's clock, with its offset.
  const when = dateTimeFormat(lang, timeZone, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  }).format(new Date(entry.at));
  const actions = t.actions as Record<string, string>;
  const actors = t.actors as Record<string, string>;
  const entities = t.entities as Record<string, string>;
  const actor = entry.actor;
  const who =
    actor.kind === "person" ? (
      <button
        type="button"
        onClick={() => onPerson(actor.id)}
        title={t.filters.onlyPerson}
        className="font-medium text-accent hover:underline"
      >
        <bdi>{inLang(actor.name) || t.list.formerUser}</bdi>
      </button>
    ) : actor.kind === "trustline_staff" && actor.name ? (
      <Words
        text={t.list.staffNamed}
        values={{ actor: actors.trustline_staff, name: <bdi dir="auto">{actor.name}</bdi> }}
      />
    ) : (
      <span className="font-medium">{actors[actor.kind] ?? actor.kind}</span>
    );
  const e = entry.entity;
  const label = e?.label
    ? typeof e.label === "string"
      ? <bdi dir="ltr" className="whitespace-nowrap">{e.label}</bdi>
      : <bdi>{inLang(e.label)}</bdi>
    : null;
  const opens = e && e.canOpen ? recordPath(lang, e.type, e.id) : null;
  return (
    <li className="flex flex-col gap-1 border-b border-line px-4 py-3 text-sm last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">{actions[entry.action] ?? entry.action}</span>
        <span className="text-xs text-muted">
          <time dateTime={entry.at}>{when}</time>
          {" · "}
          <span className="inline-block">
            {fill(t.list.number, { seq: numberFormat(lang).format(entry.seq) })}
          </span>
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {who}
        {e && (
          <span className="text-muted">
            {"· "}
            {entities[e.type] ?? e.type}{" "}
            {label &&
              (opens ? (
                <Link href={opens} className="text-accent hover:underline">
                  {label}
                </Link>
              ) : (
                label
              ))}{" "}
            <button
              type="button"
              onClick={() => onRecord(e.type, e.id)}
              className="text-xs text-accent hover:underline"
            >
              {t.filters.onlyRecord}
            </button>
          </span>
        )}
        {entry.sealedLate && <Pill tone="neutral">{t.list.sealedLate}</Pill>}
      </p>
      {entry.detailLines && entry.detailLines.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {entry.detailLines.map((line, i) => (
            <li key={i} dir="auto" className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      {entry.ip && (
        <p className="text-xs text-muted">
          {t.list.address}{" "}
          <bdi dir="ltr">{entry.ip}</bdi>
        </p>
      )}
    </li>
  );
}

/** Whether the chain is whole: its head, its last check, and any break. */
function ChainStatus({ lang, t }: { lang: string; t: AuditText }) {
  const session = useSession();
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const s = t.status;
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const breaks = t.breaks as Record<string, string>;

  useEffect(() => {
    let current = true;
    api<AuditStatus>("/audit/status").then(
      (answer) => {
        if (current) setStatus(answer);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (failed) return <p className="text-sm text-danger">{s.loadError}</p>;
  if (!status) return null;
  const head = status.head;
  const check = status.lastCheck;
  const broken = status.broken;
  const results = s.result as Record<string, string>;
  return (
    <div className="flex flex-col gap-3">
      {broken && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-danger bg-danger-soft px-4 py-3 text-sm"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-semibold">{s.brokenTitle}</p>
            <p>
              {fill(broken.firstBadSeq !== null ? s.brokenFrom : s.brokenNoSeq, {
                date: moment.format(new Date(broken.at)),
                seq: numbers.format(broken.firstBadSeq ?? 0),
                kind: breaks[broken.kind] ?? breaks.other,
              })}
            </p>
            <p>{s.brokenHelp}</p>
          </div>
        </div>
      )}
      <section
        aria-label={s.title}
        className="flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm"
      >
        <ShieldCheck
          className={`mt-0.5 size-5 shrink-0 ${broken ? "text-muted" : "text-accent"}`}
          aria-hidden
        />
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {!head
              ? s.noEntries
              : check
                ? // "Unbroken" only while no break was ever found.
                  fill(!broken && check.result === "passed" ? s.unbroken : s.checked, {
                    head: numbers.format(head.seq),
                    at: moment.format(new Date(check.at)),
                    result: results[check.result] ?? results.other,
                  })
                : fill(s.notChecked, { head: numbers.format(head.seq) })}
          </p>
          {status.sealedBefore > 0 && status.sealedOn && (
            <p className="text-muted">
              {fill(s.sealedBefore, {
                count: numbers.format(status.sealedBefore),
                date: day(status.sealedOn) ?? "",
              })}
            </p>
          )}
          <p className="text-muted">
            {status.signing === "unsigned"
              ? s.unsigned
              : check
                ? check.signed
                  ? s.signed
                  : s.notSigned
                : null}
          </p>
        </div>
      </section>
    </div>
  );
}

/** The filters, in the address: record, person, action, area and days. */
function Filters({
  lang,
  t,
  asked,
  page,
  onApply,
}: {
  lang: string;
  t: AuditText;
  asked: AuditQuery;
  page: AuditPage | null;
  onApply: (q: Partial<AuditQuery>) => void;
}) {
  const session = useSession();
  const f = t.filters;
  const actions = t.actions as Record<string, string>;
  const areas = t.areas as Record<string, string>;
  const entities = t.entities as Record<string, string>;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const offered = auditAreas.filter((a) => {
    const needs = areaModule[a];
    return !needs || hasModule(session, needs);
  });

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const read = (k: string) => String(data.get(k) ?? "").trim();
    const reference = read("reference");
    onApply({
      reference,
      entityType: reference ? "" : read("entityType"),
      // A record chosen from an entry stays chosen while its kind does.
      entityId:
        !reference && read("entityType") === asked.entityType ? asked.entityId : "",
      action: read("action"),
      area: read("area"),
      from: read("from"),
      to: read("to"),
    });
  }

  // What the address chose that the form cannot show: a person, a record.
  const person = asked.actorId
    ? page?.items.find((x) => x.actor.kind === "person" && x.actor.id === asked.actorId)
    : null;
  const personName =
    person?.actor.kind === "person" ? inLang(person.actor.name) : "";
  const record = asked.entityId
    ? page?.items.find((x) => x.entity?.id === asked.entityId)?.entity
    : null;
  const recordLabel = record?.label
    ? typeof record.label === "string"
      ? record.label
      : inLang(record.label)
    : "";
  const chip = (text: ReactNode, clear: Partial<AuditQuery>) => (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm">
      {text}
      <button
        type="button"
        onClick={() => onApply({ ...asked, ...clear })}
        className="text-xs text-accent hover:underline"
      >
        {f.remove}
      </button>
    </span>
  );

  return (
    <Panel title={f.title}>
      <form key={auditQueryString(asked)} onSubmit={apply} className="flex flex-col gap-4 p-4">
        {(asked.actorId || asked.entityId) && (
          <div className="flex flex-wrap gap-2">
            {asked.actorId &&
              chip(
                fill(f.person, { name: personName || f.personUnnamed }),
                { actorId: "" },
              )}
            {asked.entityId &&
              chip(
                fill(f.record, {
                  type: entities[asked.entityType] ?? asked.entityType,
                  label: recordLabel || f.recordUnnamed,
                }),
                { entityType: "", entityId: "" },
              )}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={f.reference} help={f.referenceHelp}>
            <input
              name="reference"
              defaultValue={asked.reference}
              maxLength={100}
              dir="ltr"
              autoComplete="off"
              className={inputClass}
            />
          </Field>
          <Field label={f.recordType}>
            <select name="entityType" defaultValue={asked.entityType} className={inputClass}>
              <option value="">{f.anyRecord}</option>
              {auditEntityTypes.map((type) => (
                <option key={type} value={type}>
                  {entities[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={f.area}>
            <select name="area" defaultValue={asked.area} className={inputClass}>
              <option value="">{f.anyArea}</option>
              {offered.map((a) => (
                <option key={a} value={a}>
                  {areas[a]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={f.action}>
            <select name="action" defaultValue={asked.action} className={inputClass}>
              <option value="">{f.anyAction}</option>
              {offered.map((a) => (
                <optgroup key={a} label={areas[a]}>
                  {auditActionsByArea[a].map((action) => (
                    <option key={action} value={action}>
                      {actions[action] ?? action}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label={f.from}>
            <input type="date" name="from" defaultValue={asked.from} dir="ltr" className={inputClass} />
          </Field>
          <Field label={f.to}>
            <input type="date" name="to" defaultValue={asked.to} dir="ltr" className={inputClass} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">{f.apply}</Button>
          <button
            type="button"
            onClick={() =>
              onApply({
                from: "",
                to: "",
                actorId: "",
                action: "",
                area: "",
                entityType: "",
                entityId: "",
                reference: "",
              })
            }
            className="text-sm text-accent hover:underline"
          >
            {f.clear}
          </button>
        </div>
      </form>
    </Panel>
  );
}

/** The CSV of what is shown, the chain file and the checkpoints, with how they are checked. */
function Downloads({ lang, t, asked }: { lang: string; t: AuditText; asked: AuditQuery }) {
  const session = useSession();
  const d = t.downloads;
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Visited pages stay mounted: no refusal waits there.
  useLayoutEffect(() => () => setFailed(null), []);
  // The CSV in the reader's language when the organization uses it.
  const locale = session.tenant.locales.includes(lang) ? lang : session.tenant.defaultLocale;

  async function get(which: string, path: string) {
    setBusy(which);
    setFailed(null);
    try {
      await download(path);
    } catch {
      setFailed(which);
    }
    setBusy(null);
  }

  // Trustline's public keys, as the file the script takes.
  async function getKeys() {
    setBusy("keys");
    setFailed(null);
    try {
      const keys = await api<unknown>("/audit/keys");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(keys, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "keys.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setFailed("keys");
    }
    setBusy(null);
  }

  const failure = (which: string) =>
    failed === which && (
      <p role="alert" className="text-sm text-danger">
        {d.failed}
      </p>
    );

  return (
    <Panel title={d.title}>
      <div className="flex flex-col gap-6 p-4">
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted">{d.csvHelp}</p>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              const q = auditApiQuery(asked);
              q.set("locale", locale);
              void get("csv", `/audit/exports/entries?${q}`);
            }}
          >
            {d.csv}
          </Button>
          {failure("csv")}
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const q = new URLSearchParams();
            for (const k of ["fromSeq", "toSeq"]) {
              const v = String(data.get(k) ?? "").trim();
              if (v) q.set(k, v);
            }
            void get("chain", `/audit/exports/chain${q.size ? `?${q}` : ""}`);
          }}
        >
          <p className="text-sm text-muted">{d.chainHelp}</p>
          <div className="grid max-w-md gap-4 sm:grid-cols-2">
            <Field label={d.fromSeq}>
              <input name="fromSeq" inputMode="numeric" pattern="[0-9]*" dir="ltr" className={inputClass} />
            </Field>
            <Field label={d.toSeq}>
              <input name="toSeq" inputMode="numeric" pattern="[0-9]*" dir="ltr" className={inputClass} />
            </Field>
          </div>
          <div>
            <Button type="submit" variant="secondary" disabled={busy !== null}>
              {d.chain}
            </Button>
          </div>
          {failure("chain")}
        </form>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const q = new URLSearchParams();
            for (const k of ["from", "to"]) {
              const v = String(data.get(k) ?? "").trim();
              if (v) q.set(k, v);
            }
            void get("checkpoints", `/audit/checkpoints${q.size ? `?${q}` : ""}`);
          }}
        >
          <p className="text-sm text-muted">{d.checkpointsHelp}</p>
          <div className="grid max-w-md gap-4 sm:grid-cols-2">
            <Field label={d.from}>
              <input type="date" name="from" dir="ltr" className={inputClass} />
            </Field>
            <Field label={d.to}>
              <input type="date" name="to" dir="ltr" className={inputClass} />
            </Field>
          </div>
          <div>
            <Button type="submit" variant="secondary" disabled={busy !== null}>
              {d.checkpoints}
            </Button>
          </div>
          {failure("checkpoints")}
        </form>

        <div className="flex flex-col gap-2 border-t border-line pt-4 text-sm">
          <p className="font-medium">{d.howTitle}</p>
          <p className="text-muted">{d.how}</p>
          <ol className="list-decimal ps-5 text-muted">
            <li>{d.step1}</li>
            <li>{d.step2}</li>
            <li>{d.step3}</li>
            <li>{d.step4}</li>
          </ol>
          <p className="text-muted">{d.script}</p>
          <code dir="ltr" className="block rounded-md bg-surface px-3 py-2 text-xs break-all">
            {d.command}
          </code>
          <div>
            <Button variant="secondary" disabled={busy !== null} onClick={() => void getKeys()}>
              {d.keys}
            </Button>
            {failure("keys")}
          </div>
        </div>
      </div>
    </Panel>
  );
}
