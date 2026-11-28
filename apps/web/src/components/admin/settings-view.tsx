"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { can, useRefreshSession, useSession } from "@/components/shell/session";
import {
  hasModule,
  useReadOnly,
  useSubscriptionRefusal,
} from "@/components/shell/subscription";
import { features } from "@/config/modules";
import type { Dictionary } from "@/i18n/dictionaries";
import { Button } from "@/components/ui/button";
import { CopyLink } from "@/components/ui/copy-link";
import { inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import { numberFormat } from "@/lib/format";
import { followUpUrl, publicReportUrl } from "@/lib/identity";
import { harmLevels, type HarmLevel } from "@/lib/incidents";
import { pick, readForm, type Localized } from "@/lib/localized";
import { SubscriptionPanel } from "./subscription-panel";
import type { AdminProps } from "./types";

type Reporting = { publicReporting: boolean; slug: string };
type Message = { kind: "ok" | "error"; text: string };

/** How long the hospital allows itself, for one harm level. */
type ResponseRule = {
  harmLevel: HarmLevel;
  triageWithinHours: number;
  closeWithinDays: number;
};

/**
 * What is stored, and how many times it has been read or saved: the form
 * starts again from the stored figures each time.
 */
type Stored = { rules: ResponseRule[]; version: number };

const adopted =
  ({ rules }: { rules: ResponseRule[] }) =>
  (was: Stored | null): Stored => ({
    rules,
    version: (was?.version ?? 0) + 1,
  });

/** What the API accepts; the fields only stop a slip before it is sent. */
const LIMITS = { hours: { min: 1, max: 720 }, days: { min: 1, max: 365 } };

type Props = AdminProps & {
  /** The harm levels in words, as the incident screens name them. */
  harm: Record<HarmLevel, string>;
  moduleNames: Dictionary["moduleNames"];
};

function Said({ message }: { message: Message | null }) {
  if (!message) return null;
  return (
    <p
      role={message.kind === "error" ? "alert" : "status"}
      className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
    >
      {message.text}
    </p>
  );
}

/**
 * The organization's own settings, one panel each: reporting without
 * sign-in and the deadlines for triage and closure (while it has
 * incidents), and its subscription. Each panel reads and saves on its own,
 * so a problem with one does not hide the other.
 *
 * Changing a setting takes `settings.manage` for the whole organization.
 * Someone who may triage is held to the deadlines, so can read them here,
 * and nothing else.
 */
export function SettingsView(props: Props) {
  const { t } = props;
  const session = useSession();
  const manages = can(session, "settings.manage");
  const triages = can(session, "incidents.triage");
  const wholeOrganization = session.scope?.["settings.manage"] === "all";
  const reporting = manages && hasModule(session, features.reportingSettings);
  const deadlines = hasModule(session, features.deadlineSettings);
  const s = t.settings;

  const header = <PageHeader title={s.title} description={s.description} />;
  if (!manages && !triages) {
    return (
      <>
        {header}
        <EmptyState>{t.noAccess}</EmptyState>
      </>
    );
  }

  // Someone whose role covers only part of the organization, at a client
  // without incidents: no setting is theirs to read.
  if (!reporting && !deadlines && !wholeOrganization) {
    return (
      <>
        {header}
        <EmptyState>{s.wholeOrganization}</EmptyState>
      </>
    );
  }

  return (
    <>
      {header}
      {/* One panel per setting, one under the other. */}
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        {reporting && <ReportingPanel {...props} />}
        {deadlines && (
          <DeadlinesPanel {...props} editable={wholeOrganization} />
        )}
        {wholeOrganization && <EmailPanel {...props} />}
        {wholeOrganization && <OptOutsPanel {...props} />}
        {wholeOrganization && <SubscriptionPanel {...props} />}
      </div>
    </>
  );
}

/** Email for the whole organization, as the API reports it. */
type EmailSetting = { enabled: boolean; delivery: "smtp" | "outbox" | (string & {}) };

/**
 * Email for the whole organization: on or off, and whether mail actually
 * leaves (a mail service is configured) or is kept in the outbox. While
 * the subscription is suspended it can be switched off, not on.
 */
function EmailPanel({ lang, t }: Props) {
  const refusal = useSubscriptionRefusal();
  const readOnly = useReadOnly();
  const [email, setEmail] = useState<EmailSetting | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const s = t.settings;
  const e = s.email;

  useEffect(() => {
    let current = true;
    api<EmailSetting>("/settings/email")
      .then((loaded) => {
        if (!current) return;
        setEmail(loaded);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 403 ? s.wholeOrganization : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [s, t]);

  // Visited pages stay mounted: "Switched on." must not wait there.
  useLayoutEffect(() => () => setMessage(null), []);

  async function setOn(enabled: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      setEmail(
        await api<EmailSetting>("/settings/email", {
          method: "PUT",
          body: { enabled },
        }),
      );
      setMessage({ kind: "ok", text: enabled ? e.switchedOn : e.switchedOff });
    } catch (err) {
      setMessage({
        kind: "error",
        text:
          refusal(err) ??
          (statusOf(err) === 403 ? s.wholeOrganization : s.error),
      });
    }
    setBusy(false);
  }

  if (problem || !email) {
    return (
      <Panel title={e.title}>
        <EmptyState>{problem ?? t.loading}</EmptyState>
      </Panel>
    );
  }

  const on = email.enabled;
  // Suspended: off stays possible, on waits until it is active again.
  const blocked = readOnly && !on;
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{e.title}</h2>
        <Pill tone={on ? "ok" : "neutral"}>{on ? e.on : e.off}</Pill>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2 text-sm">
          <p>{e.what}</p>
          <p className="text-muted">{on ? e.onHelp : e.offHelp}</p>
          <p className="text-muted">
            <Link
              href={`/${lang}/notifications/preferences`}
              className="text-accent hover:underline"
            >
              {e.ownPreferences}
            </Link>
          </p>
        </div>
        {on && email.delivery === "outbox" && (
          <p
            role="note"
            className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm"
          >
            {e.outbox}
          </p>
        )}
        {readOnly && (
          <p className="text-sm text-muted">
            {on ? e.suspendedOff : e.suspendedOn}
          </p>
        )}
        <Said message={message} />
        <div>
          <Button
            variant={on ? "secondary" : "primary"}
            disabled={busy || blocked}
            onClick={() => setOn(!on)}
          >
            {on ? e.switchOff : e.switchOn}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** A person who has switched some of their emails off. */
type OptOut = {
  id: string;
  name: Localized;
  immediate: boolean;
  digest: boolean;
  /** Whether others count on their emails: approval steps, triage. */
  reliedOn: { approves: boolean; triages: boolean };
};

/**
 * Who has switched which emails off, by name only: so that an
 * administrator can see when someone others rely on, an approver or a
 * triager, would hear of their work only in Trustline.
 */
function OptOutsPanel({ lang, t }: Props) {
  const session = useSession();
  const [list, setList] = useState<{ items: OptOut[]; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const o = t.settings.optOuts;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);

  useEffect(() => {
    let current = true;
    api<{ items: OptOut[]; total: number }>("/settings/email/opt-outs")
      .then((loaded) => {
        if (!current) return;
        setList(loaded);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 403 ? t.settings.wholeOrganization : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [t]);

  return (
    <Panel title={o.title}>
      {problem ? (
        <EmptyState>{problem}</EmptyState>
      ) : !list ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : list.items.length === 0 ? (
        <EmptyState>{o.empty}</EmptyState>
      ) : (
        <>
          <p className="px-4 pt-3 text-sm text-muted">{o.help}</p>
          <ul className="mt-2">
            {list.items.map((person) => {
              const relied = person.reliedOn.approves || person.reliedOn.triages;
              return (
                <li
                  key={person.id}
                  className={`flex flex-col gap-1.5 border-t border-line py-3 pe-4 text-sm ${
                    relied ? "border-s-4 border-s-warn ps-3" : "ps-4"
                  }`}
                >
                  <bdi className="font-medium">{inLang(person.name)}</bdi>
                  <div className="flex flex-wrap gap-1.5">
                    {!person.immediate && <Pill tone="neutral">{o.immediateOff}</Pill>}
                    {!person.digest && <Pill tone="neutral">{o.digestOff}</Pill>}
                    {person.reliedOn.approves && <Pill tone="warn">{o.approves}</Pill>}
                    {person.reliedOn.triages && <Pill tone="warn">{o.triages}</Pill>}
                  </div>
                  {relied && !person.immediate && (
                    <p className="text-xs text-warn">{o.reliedHelp}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}

/** Reporting without sign-in: the switch, and the links to pass on. */
function ReportingPanel({ t }: Props) {
  const refreshSession = useRefreshSession();
  const refusal = useSubscriptionRefusal();
  const [reporting, setReporting] = useState<Reporting | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const s = t.settings;
  const r = s.reporting;

  useEffect(() => {
    let current = true;
    api<Reporting>("/settings/reporting")
      .then((loaded) => {
        if (!current) return;
        setReporting(loaded);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 403 ? s.wholeOrganization : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [s, t]);

  // Visited pages stay mounted: "Switched on." must not be waiting here
  // when the page is shown again.
  useLayoutEffect(() => () => setMessage(null), []);

  async function setOn(publicReporting: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      setReporting(
        await api<Reporting>("/settings/reporting", {
          method: "PUT",
          body: { publicReporting },
        }),
      );
      setMessage({
        kind: "ok",
        text: publicReporting ? r.switchedOn : r.switchedOff,
      });
      // The Organization pages show reporting links only while this is on.
      await refreshSession();
    } catch (err) {
      setMessage({
        kind: "error",
        text:
          refusal(err) ??
          (statusOf(err) === 403 ? s.wholeOrganization : s.error),
      });
    }
    setBusy(false);
  }

  if (problem || !reporting) {
    return (
      <Panel title={r.title}>
        <EmptyState>{problem ?? t.loading}</EmptyState>
      </Panel>
    );
  }

  const on = reporting.publicReporting;
  const copy = { copy: r.copy, copied: r.copied };

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{r.title}</h2>
        <Pill tone={on ? "ok" : "neutral"}>{on ? r.on : r.off}</Pill>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2 text-sm">
          <p>{r.what}</p>
          <p className="text-muted">{r.shows}</p>
          <p className="text-muted">{on ? r.onHelp : r.offHelp}</p>
        </div>
        <Said message={message} />
        <div>
          <Button
            variant={on ? "secondary" : "primary"}
            disabled={busy}
            onClick={() => setOn(!on)}
          >
            {on ? r.switchOff : r.switchOn}
          </Button>
        </div>
        <div className="flex flex-col gap-5 border-t border-line pt-4">
          {on && (
            <CopyLink
              label={r.link}
              help={r.linkHelp}
              url={publicReportUrl(reporting.slug)}
              t={copy}
            />
          )}
          <CopyLink
            label={r.followUpLink}
            help={r.followUpHelp}
            url={followUpUrl(reporting.slug)}
            t={copy}
          />
        </div>
      </div>
    </Panel>
  );
}

/**
 * The deadline table: for each harm level, the hours to triage a report and
 * the days to close the incident. Fields for whoever may change them, plain
 * figures for whoever may only read them.
 */
function DeadlinesPanel({
  lang,
  t,
  harm,
  editable,
}: Props & { editable: boolean }) {
  const refusal = useSubscriptionRefusal();
  const [stored, setStored] = useState<Stored | null>(null);
  const [problem, setProblem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const s = t.settings;
  const d = s.deadlines;
  const numbers = numberFormat(lang);

  useEffect(() => {
    let current = true;
    api<{ rules: ResponseRule[] }>("/settings/response-rules")
      .then((loaded) => {
        if (!current) return;
        setStored(adopted(loaded));
        setProblem(false);
      })
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, []);

  // Visited pages stay mounted: "Saved." must not be waiting here when the
  // page is shown again. (Figures typed and not saved go too: the table is
  // read again, and drawn again from what is stored.)
  useLayoutEffect(() => () => setMessage(null), []);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { hours, days } = readForm(e.currentTarget) as {
      hours: Record<string, string>;
      days: Record<string, string>;
    };
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<{ rules: ResponseRule[] }>(
        "/settings/response-rules",
        {
          method: "PUT",
          body: {
            rules: harmLevels.map((harmLevel) => ({
              harmLevel,
              triageWithinHours: Number(hours[harmLevel]),
              closeWithinDays: Number(days[harmLevel]),
            })),
          },
        },
      );
      setStored(adopted(saved));
      setMessage({ kind: "ok", text: d.saved });
    } catch (err) {
      const status = statusOf(err);
      setMessage({
        kind: "error",
        text:
          refusal(err) ??
          (status === 400
            ? d.invalid
            : status === 403
              ? s.wholeOrganization
              : s.error),
      });
    }
    setBusy(false);
  }

  if (problem || !stored) {
    return (
      <Panel title={d.title}>
        <EmptyState>{problem ? t.loadError : t.loading}</EmptyState>
      </Panel>
    );
  }

  // In the order of the screen, whatever order they arrived in.
  const rows = harmLevels
    .map((level) => stored.rules.find((rule) => rule.harmLevel === level))
    .filter((rule) => rule !== undefined);

  const figure = (
    name: "hours" | "days",
    level: HarmLevel,
    value: number,
    column: string,
  ): ReactNode =>
    editable ? (
      <input
        // No id and no visible label of its own: the row and the column
        // name it, and so does this.
        aria-label={`${harm[level]} · ${column}`}
        name={`${name}.${level}`}
        type="number"
        inputMode="numeric"
        required
        step={1}
        min={LIMITS[name].min}
        max={LIMITS[name].max}
        defaultValue={value}
        dir="ltr"
        className={`${inputClass} max-w-28 tabular-nums`}
      />
    ) : (
      <span className="tabular-nums">{numbers.format(value)}</span>
    );

  const table = (
    <div className="overflow-x-auto">
      <table className="w-full text-start text-sm">
        <thead>
          <tr className="border-b border-line text-muted">
            {[d.level, d.hours, d.days].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="px-4 py-2 text-start align-bottom font-medium"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((rule) => (
            <tr key={rule.harmLevel} className="border-b border-line">
              <th scope="row" className="px-4 py-2 text-start font-medium">
                {harm[rule.harmLevel]}
              </th>
              <td className="px-4 py-2">
                {figure(
                  "hours",
                  rule.harmLevel,
                  rule.triageWithinHours,
                  d.hours,
                )}
              </td>
              <td className="px-4 py-2">
                {figure("days", rule.harmLevel, rule.closeWithinDays, d.days)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Panel title={d.title}>
      <div className="flex flex-col gap-2 p-4 text-sm">
        <p>{d.what}</p>
        <p className="text-muted">{d.applies}</p>
        <p className="text-muted">{d.sentinel}</p>
      </div>
      {editable ? (
        <form key={stored.version} onSubmit={save}>
          {table}
          <div className="flex flex-col gap-3 p-4">
            <p className="text-xs text-muted">{d.limits}</p>
            <Said message={message} />
            <div>
              <Button type="submit" disabled={busy}>
                {d.save}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <>
          {table}
          <p className="p-4 text-sm text-muted">{d.readOnly}</p>
        </>
      )}
    </Panel>
  );
}
