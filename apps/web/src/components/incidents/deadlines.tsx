import { Clock } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { dateTimeFormat, deadlineFormat, fill, momentFrom } from "@/lib/format";
import {
  liveDeadline,
  type Deadlines,
  type IncidentStatus,
} from "@/lib/incidents";
import type { TimeZone } from "@/lib/time-zone";
import type { IncidentsProps } from "./types";

/**
 * The two deadlines of an incident, both as dates on the hospital's clock,
 * with the one it is being held to now put in words. Nothing at all where
 * there is no deadline to show: for someone who sees the incident only as
 * its reporter, and briefly for one stored before deadlines existed.
 */
export function IncidentDeadlines({
  lang,
  t,
  incident,
  timeZone,
  at,
}: IncidentsProps & {
  incident: Partial<Deadlines> & { status: IncidentStatus };
  timeZone: TimeZone;
  /** When the incident was read: what "in 5 hours" is counted from. */
  at: Date;
}) {
  const d = t.deadline;
  const dates = dateTimeFormat(lang, timeZone);
  const live = liveDeadline(incident, at);
  const rows = (
    [
      ["triage", momentFrom(incident.triageDueAt)],
      ["closure", momentFrom(incident.closeDueAt)],
    ] as const
  ).filter((row): row is ["triage" | "closure", Date] => row[1] !== null);
  if (rows.length === 0) return null;

  return (
    <Panel title={d.title}>
      <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2">
        {rows.map(([kind, due]) => {
          const current = live?.kind === kind ? live : null;
          return (
            <div key={kind}>
              <dt className="text-xs font-medium text-muted">{d.by[kind]}</dt>
              <dd className={`mt-0.5 ${current ? "" : "text-muted"}`}>
                <time dateTime={due.toISOString()}>{dates.format(due)}</time>
              </dd>
              {current && (
                <dd className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`font-medium ${current.late ? "text-danger" : ""}`}
                  >
                    {fill(d[current.late ? "late" : "due"][kind], {
                      when: deadlineFormat(lang)(due, at),
                    })}
                  </span>
                  {current.late ? (
                    <Pill
                      tone="danger"
                      icon={<Clock className="size-3 shrink-0" aria-hidden />}
                    >
                      {d.overdue}
                    </Pill>
                  ) : (
                    <Pill tone="ok">{d.current}</Pill>
                  )}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </Panel>
  );
}
