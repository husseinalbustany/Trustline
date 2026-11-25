import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { dateTimeFormat, fill } from "@/lib/format";
import {
  wordFor,
  type FollowUpView,
  type IncidentEvent,
  type Was,
} from "@/lib/incidents";
import { pick, type Localized } from "@/lib/localized";
import type { IncidentsProps } from "./types";

/**
 * The parts of an incident that every reader gets: the report, its timeline
 * and its comments. The signed-in page and the follow-up page (for someone
 * who came with a code) are built from them.
 */
export type ViewProps = IncidentsProps & {
  incident: FollowUpView;
  /** The hospital's own language, for text not written in the reader's. */
  fallback?: string;
  /**
   * `hidden` for a reader who came with a follow-up code: they are never
   * shown a person's name, whatever the answer holds.
   */
  names?: "shown" | "hidden";
};

/** One thing a triage set or changed: "Harm level: Mild harm → Severe harm". */
type Change = { label: string; from?: string; to: string };

type Doer = { byReporter: boolean; byStaff?: boolean };

/** Who did something, in words: a name only where the reader may have it. */
function doer(
  { t, lang, fallback, names }: ViewProps,
  person: { name: Localized } | null,
  { byReporter, byStaff }: Doer,
) {
  if (person && names !== "hidden") return pick(person.name, lang, fallback);
  if (byReporter) return t.timeline.theReporter;
  return byStaff || names === "hidden"
    ? t.timeline.staff
    : t.timeline.unknownPerson;
}

/** What was reported: the text, then the facts. */
export function IncidentReport(props: ViewProps) {
  const { lang, t, incident, fallback } = props;
  const d = t.detail;
  const dates = dateTimeFormat(lang);
  const when = (iso: string) => dates.format(new Date(iso));
  // A name a client wrote keeps its own direction.
  const name = (text: Localized) => <bdi>{pick(text, lang, fallback)}</bdi>;

  const facts: [string, ReactNode][] = [
    [d.type, t.type[incident.type]],
    [d.category, name(incident.category.name)],
    [d.where, name(incident.orgUnit.name)],
    [d.occurredAt, when(incident.occurredAt)],
    [d.reportedAt, when(incident.reportedAt)],
    [
      d.reportedBy,
      // A reader who may not know is told that, and nothing about whether
      // there is a name to know.
      !incident.reporterShown
        ? d.reporterHidden
        : incident.reporter
          ? name(incident.reporter.name)
          : d.anonymous,
    ],
    [d.harmLevel, t.harm[incident.harmLevel]],
    [
      d.ownerUnit,
      incident.ownerUnit ? name(incident.ownerUnit.name) : d.ownerUnitNone,
    ],
  ];
  // Who it is assigned to is for the people handling it, not the reporter.
  if (incident.access === "full") {
    facts.push([
      d.assignedTo,
      incident.assignedTo ? name(incident.assignedTo.name) : d.assignedToNone,
    ]);
  }

  const written: [string, string | null][] = [
    [d.whatHappened, incident.description],
    [d.immediateAction, incident.immediateAction],
    [
      // Until a second person signs it off, the summary is a proposal.
      incident.status === "awaiting_sign_off"
        ? d.proposedSummary
        : d.closureSummary,
      incident.closureSummary,
    ],
    [d.rejectionReason, incident.rejectionReason],
  ];

  return (
    <Panel title={d.report}>
      <div className="flex flex-col gap-4 p-4">
        {written.map(
          ([label, text]) =>
            text && (
              <div key={label}>
                <h3 className="text-xs font-medium text-muted">{label}</h3>
                <p
                  dir="auto"
                  className="mt-1 text-sm break-words whitespace-pre-wrap"
                >
                  {text}
                </p>
              </div>
            ),
        )}
        <dl className="grid gap-x-6 gap-y-3 border-t border-line pt-4 text-sm sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-muted">{label}</dt>
              <dd className="mt-0.5">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}

/** What has happened to the incident, oldest first. */
export function IncidentTimeline(props: ViewProps) {
  const { lang, t, incident, fallback, names } = props;
  const d = t.detail;
  const dates = dateTimeFormat(lang);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, fallback);
  // The incident carries the name of everything its timeline mentions,
  // including units and categories switched off since and people who left.
  const unitName = (unitId: string) => {
    const known =
      incident.units?.[unitId] ??
      [incident.orgUnit, incident.ownerUnit].find((u) => u?.id === unitId)
        ?.name;
    return known ? inLang(known) : t.inactiveUnit;
  };
  const categoryName = (categoryId: string) =>
    inLang(
      incident.categories?.[categoryId] ??
        (incident.category.id === categoryId ? incident.category.name : null),
    );
  const statusName = (status: string | null) =>
    wordFor(t.status, status, t.statusOther);

  /**
   * What a triage did to one field, in words. A newer event holds
   * `{ from, to }` and only for what changed; an older one holds the value
   * it set, and nothing of what was there before.
   */
  const change = <T,>(
    label: string,
    was: Was<T> | undefined,
    word: (value: T) => string,
  ): Change | null => {
    if (was === undefined) return null;
    return was !== null && typeof was === "object" && "to" in was
      ? { label, from: word(was.from), to: word(was.to) }
      : { label, to: word(was as T) };
  };

  /** A timeline entry in words: what happened, and what it changed. */
  const describe = (event: IncidentEvent): [string, Change[]] => {
    const e = t.timeline.events;
    const c = t.timeline.changed;
    switch (event.kind) {
      case "triaged": {
        const details = event.details ?? {};
        // An older event recorded "not sentinel" every time; it says
        // nothing, so only a real change or a "yes" is shown.
        const sentinel =
          details.isSentinel === false ? undefined : details.isSentinel;
        return [
          e.triaged,
          [
            change(c.harmLevel, details.harmLevel, (v) => t.harm[v]),
            change(c.isSentinel, sentinel, (v) => (v ? t.yes : t.no)),
            change(c.categoryId, details.categoryId, categoryName),
            change(c.ownerUnitId, details.ownerUnitId, (v) =>
              v ? unitName(v) : d.ownerUnitNone,
            ),
          ].filter((line) => line !== null),
        ];
      }
      case "assigned": {
        const { ownerUnitId, assignedTo } = event.details;
        const unit = unitName(ownerUnitId);
        if (!assignedTo) return [fill(e.assignedUnit, { unit }), []];
        // The event names the person by id only.
        const person =
          names === "hidden"
            ? null
            : (incident.people?.[assignedTo] ??
              (incident.assignedTo?.id === assignedTo
                ? incident.assignedTo.name
                : null));
        return [
          person
            ? fill(e.assigned, { name: inLang(person), unit })
            : fill(e.assignedSomeone, { unit }),
          [],
        ];
      }
      case "commented":
        return [
          event.details?.visibility === "internal"
            ? e.commentedInternal
            : e.commented,
          [],
        ];
      case "reported":
      case "closed":
      case "rejected":
      case "reopened":
      case "sign_off_requested":
      case "signed_off":
      case "sent_back":
        return [e[event.kind], []];
      default:
        // A request for sign-off taken back is a plain change of status
        // that says so.
        if (event.kind === "status_changed" && event.details?.withdrawn) {
          return [e.withdrawn, []];
        }
        // A plain change of status, or a kind of entry added to the API
        // since: said by where the incident went, never by a raw code.
        return [
          event.fromStatus && event.toStatus
            ? fill(e.status_changed, {
                from: statusName(event.fromStatus),
                to: statusName(event.toStatus),
              })
            : e.other,
          [],
        ];
    }
  };
  // Whatever the kind of entry, a note written with it is shown.
  const noteOf = ({ details }: { details: object | null }) => {
    const note = details && "note" in details ? details.note : null;
    return typeof note === "string" ? note : null;
  };

  return (
    <Panel title={t.timeline.title}>
      <ol className="flex flex-col gap-4 p-4">
        {incident.events.map((event) => {
          const [headline, changes] = describe(event);
          const note = noteOf(event);
          return (
            <li key={event.id} className="border-s-2 border-line ps-3 text-sm">
              <p className="font-medium">{headline}</p>
              {changes.length > 0 && (
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {changes.map(({ label, from, to }) => (
                    <li key={label}>
                      <span className="text-muted">{label}</span>{" "}
                      {from === undefined ? (
                        <bdi>{to}</bdi>
                      ) : (
                        <>
                          <bdi>{from}</bdi>{" "}
                          {/* The arrow stays with the value it points at
                              when the line breaks. It points the way the
                              line is read: turned round in a right-to-left
                              language. */}
                          <span className="inline-block">
                            <ArrowRight
                              className="inline size-3.5 text-muted rtl:-scale-x-100"
                              aria-hidden
                            />
                            <span className="sr-only">
                              {t.timeline.changedTo}
                            </span>{" "}
                            <bdi>{to}</bdi>
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {note && (
                <p className="mt-1">
                  <span className="text-muted">{t.timeline.note} </span>
                  <bdi dir="auto" className="break-words whitespace-pre-wrap">
                    {note}
                  </bdi>
                </p>
              )}
              <p className="mt-0.5 text-xs text-muted">
                {fill(t.timeline.byline, {
                  name: doer(props, event.actor, event),
                  date: dates.format(new Date(event.occurredAt)),
                })}
              </p>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/** The comments, and under them whatever lets this reader add one. */
export function IncidentComments({
  children,
  ...props
}: ViewProps & { children?: ReactNode }) {
  const { lang, t, incident } = props;
  const dates = dateTimeFormat(lang);

  return (
    <Panel title={t.comments.title}>
      {incident.comments.length === 0 ? (
        <p className="px-4 pt-4 text-sm text-muted">{t.comments.empty}</p>
      ) : (
        <ul>
          {incident.comments.map((comment) => (
            <li
              key={comment.id}
              className="border-b border-line px-4 py-3 text-sm"
            >
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                {fill(t.timeline.byline, {
                  name: doer(props, comment.author, comment),
                  date: dates.format(new Date(comment.createdAt)),
                })}
                {comment.visibility === "internal" && (
                  <Pill tone="neutral">{t.comments.internal}</Pill>
                )}
              </p>
              <p dir="auto" className="mt-1 break-words whitespace-pre-wrap">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}
      {children}
    </Panel>
  );
}
