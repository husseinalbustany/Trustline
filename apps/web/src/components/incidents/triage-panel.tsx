"use client";

import { useState, type FormEvent } from "react";
import { canIn, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { api, codeOf } from "@/lib/api";
import type { OrgUnit } from "@/lib/identity";
import {
  canBeTriaged,
  harmLevels,
  statusMoves,
  unitOptions,
  type AssignableUser,
  type Incident,
  type IncidentCategory,
  type StatusAction,
} from "@/lib/incidents";
import { pick, readForm, type Localized } from "@/lib/localized";
import { explain, textareaClass, type IncidentsProps } from "./types";

type Message = { kind: "ok" | "error"; text: string };

function Note({ message }: { message: Message | null }) {
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

type Shared = IncidentsProps & {
  incident: Incident;
  /** The incident as the API returned it after a change. */
  onChange: (incident: Incident) => void;
  /** The incident is no longer as shown here: fetch it again. */
  onStale: () => void;
};

/** What someone with triage rights over this incident can do with it. */
export function TriagePanel({
  units,
  categories,
  staff,
  staffProblem,
  ...shared
}: Shared & {
  units: OrgUnit[];
  categories: IncidentCategory[];
  staff: AssignableUser[];
  staffProblem: boolean;
}) {
  const { lang, t, incident, onChange, onStale } = shared;
  const session = useSession();
  const [ownerUnitId, setOwnerUnitId] = useState(incident.ownerUnit?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const inLang = (text: Localized) =>
    pick(text, lang, session.tenant.defaultLocale);
  const g = t.triage;
  const open = canBeTriaged(incident.status);

  // Triage rights come from where the incident happened or who owns it.
  // Handing it to a unit outside both ends this user's rights over it.
  const leavesScope =
    ownerUnitId !== "" &&
    !canIn(session, "incidents.triage", incident.orgUnit.id) &&
    !canIn(session, "incidents.triage", ownerUnitId);

  const unitNames = new Map(units.map((u) => [u.id, inLang(u.name)]));
  // Whoever has it now stays in the list, so saving does not drop them.
  const people = [...staff];
  if (
    incident.assignedTo &&
    !people.some((p) => p.id === incident.assignedTo?.id)
  ) {
    people.unshift({ ...incident.assignedTo, orgUnitId: null });
  }
  const options = [...categories];
  if (!options.some((c) => c.id === incident.category.id)) {
    options.unshift({ ...incident.category, code: "" });
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { harmLevel, isSentinel, categoryId, assignedTo } = readForm(
      e.currentTarget,
    );
    setBusy(true);
    setMessage(null);
    try {
      onChange(
        await api<Incident>(`/incidents/${incident.id}/triage`, {
          method: "POST",
          body: {
            harmLevel,
            isSentinel: isSentinel === "on",
            categoryId,
            ownerUnitId,
            assignedTo: assignedTo || null,
          },
        }),
      );
      setMessage({ kind: "ok", text: g.saved });
    } catch (err) {
      if (codeOf(err) === "invalid_transition") onStale();
      setMessage({ kind: "error", text: explain(err, t.errors) });
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-6">
      {open && (
        <Panel title={incident.status === "new" ? g.title : g.retitle}>
          <form
            // Starts again from what was saved after every change.
            key={incident.events.length}
            onSubmit={submit}
            className="flex flex-col gap-4 p-4"
          >
            <p className="text-sm text-muted">{g.help}</p>
            <Field label={g.harmLevel}>
              <select
                name="harmLevel"
                required
                defaultValue={incident.harmLevel}
                className={inputClass}
              >
                {harmLevels.map((level) => (
                  <option key={level} value={level}>
                    {t.harm[level]}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                name="isSentinel"
                defaultChecked={incident.isSentinel}
                className="size-4 accent-accent"
              />
              {g.sentinel}
            </label>
            <Field label={g.category}>
              <select
                name="categoryId"
                required
                defaultValue={incident.category.id}
                className={inputClass}
              >
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {inLang(c.name)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={g.ownerUnit}>
              <select
                required
                value={ownerUnitId}
                onChange={(e) => setOwnerUnitId(e.target.value)}
                className={inputClass}
              >
                <option value="" disabled>
                  {t.form.choose}
                </option>
                {unitOptions(units, (u) => inLang(u.name)).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
            {leavesScope && (
              <p role="status" className="text-sm text-danger">
                {g.leavesScope}
              </p>
            )}
            <Field
              label={g.assignee}
              help={staffProblem ? g.usersError : undefined}
            >
              <select
                name="assignedTo"
                defaultValue={incident.assignedTo?.id ?? ""}
                className={inputClass}
              >
                <option value="">{g.assigneeNone}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {[inLang(p.name), p.orgUnitId && unitNames.get(p.orgUnitId)]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </select>
            </Field>
            <Note message={message} />
            <div>
              <Button type="submit" disabled={busy}>
                {g.submit}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      {/* Triage was refused because the incident has since moved on. */}
      {!open && message?.kind === "error" && <Note message={message} />}
      <StatusActions {...shared} />
    </div>
  );
}

/** Only the status changes the API accepts from the current status. */
function StatusActions({ t, incident, onChange, onStale }: Shared) {
  const [chosen, setChosen] = useState<StatusAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const a = t.actions;
  const moves = statusMoves[incident.status];
  const move = moves.find((m) => m.action === chosen);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!move) return;
    const form = e.currentTarget;
    const { note } = readForm(form);
    setBusy(true);
    setMessage(null);
    try {
      onChange(
        await api<Incident>(`/incidents/${incident.id}/status`, {
          method: "POST",
          body: { to: move.to, note: note || null },
        }),
      );
      form.reset();
      setChosen(null);
      setMessage({ kind: "ok", text: a.done });
    } catch (err) {
      if (codeOf(err) === "invalid_transition") {
        setChosen(null);
        onStale();
      }
      setMessage({ kind: "error", text: explain(err, t.errors) });
    }
    setBusy(false);
  }

  return (
    <Panel title={a.title}>
      <div className="flex flex-col gap-4 p-4">
        {!move && (
          <div className="flex flex-wrap gap-2">
            {moves.map((m) => (
              <Button
                key={m.action}
                variant="secondary"
                onClick={() => {
                  setMessage(null);
                  setChosen(m.action);
                }}
              >
                {a[m.action]}
              </Button>
            ))}
          </div>
        )}
        {move && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm font-medium">{a[move.action]}</p>
            <Field label={a.note[move.action]} help={a.noteHelp}>
              <textarea
                name="note"
                rows={3}
                maxLength={2000}
                required={move.note === "required"}
                dir="auto"
                className={textareaClass}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {a.confirm}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setChosen(null)}
              >
                {a.cancel}
              </Button>
            </div>
          </form>
        )}
        <Note message={message} />
      </div>
    </Panel>
  );
}
