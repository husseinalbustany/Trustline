"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect, useState, type FormEvent } from "react";
import { canIn, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { api, codeOf } from "@/lib/api";
import { fill } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import {
  harmLevels,
  wordFor,
  type AssignableUser,
  type Incident,
  type IncidentCategory,
  type StatusMove,
} from "@/lib/incidents";
import { pick, readForm, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import { explain, textareaClass, type IncidentsProps } from "./types";

/**
 * What a triage or a status change answered. A "saved" note belongs to the
 * version of the incident it produced, and is not shown over a later one.
 */
type Message = {
  kind: "ok" | "error";
  text: string;
  at: "triage" | "status";
  revision?: number;
};

/**
 * The incident is no longer as this page shows it, or the page offered
 * something the API will not take: it must be read again, so the choices
 * shown are the ones there really are.
 */
const isStale = (err: unknown) =>
  [
    "invalid_transition",
    "stale_incident",
    "sign_off_required",
    "same_person",
    "kind_required",
    "revision_required",
  ].includes(codeOf(err) ?? "");

function Note({ message }: { message: Message | null | false }) {
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

type Lists = {
  units: OrgUnit[];
  categories: IncidentCategory[];
  staff: AssignableUser[];
  staffProblem: boolean;
};

type Part = Shared & {
  message: Message | null | false;
  say: (message: Message | null) => void;
};

/**
 * What someone with triage rights over this incident can do with it now.
 * The API says what that is: `canRetriage` for the triage form, `moves` for
 * the status changes. Nothing here knows the rules.
 */
export function TriagePanel({
  units,
  categories,
  staff,
  staffProblem,
  ...shared
}: Shared & Lists) {
  const { incident } = shared;
  const [said, say] = useState<Message | null>(null);

  // Visited pages stay mounted: "Triage saved." must not be waiting here
  // when the page is shown again.
  useLayoutEffect(() => () => say(null), []);

  const message =
    said && (said.kind === "error" || said.revision === incident.revision)
      ? said
      : null;
  const about = (at: Message["at"]) => message?.at === at && message;

  return (
    <div className="flex flex-col gap-6">
      {incident.canRetriage ? (
        <TriageForm
          // Starts again from what is stored whenever the incident is
          // triaged or changes status, here or by someone else. A comment
          // does not raise the revision, so it leaves unsaved choices alone.
          // (The two keys differ: these are children of the same element.)
          key={`triage:${incident.revision}`}
          {...shared}
          units={units}
          categories={categories}
          staff={staff}
          staffProblem={staffProblem}
          message={about("triage")}
          say={say}
        />
      ) : (
        // Triage was refused because the incident has since moved on.
        <Note message={about("triage")} />
      )}
      {incident.moves.length > 0 ? (
        <StatusActions
          key={`status:${incident.revision}`}
          {...shared}
          message={about("status")}
          say={say}
        />
      ) : (
        <Note message={about("status")} />
      )}
    </div>
  );
}

function TriageForm({
  lang,
  t,
  incident,
  onChange,
  onStale,
  units,
  categories,
  staff,
  staffProblem,
  message,
  say,
}: Part & Lists) {
  const session = useSession();
  const router = useRouter();
  const [ownerUnitId, setOwnerUnitId] = useState(incident.ownerUnit?.id ?? "");
  const [busy, setBusy] = useState(false);
  const inLang = (text: Localized) =>
    pick(text, lang, session.tenant.defaultLocale);
  const g = t.triage;

  // Triage rights come from where the incident happened or who owns it.
  // Handing it to a unit outside both ends this user's rights over it.
  const leavesScope =
    ownerUnitId !== "" &&
    !canIn(session, "incidents.triage", incident.orgUnit.id) &&
    !canIn(session, "incidents.triage", ownerUnitId);

  // The department it was handed to may have been switched off since. It is
  // shown, marked inactive, but cannot be saved again: a new one is needed.
  const { ownerUnit } = incident;
  const ownerOptions = unitOptions(
    units,
    (u) => inLang(u.name),
    ownerUnit && {
      id: ownerUnit.id,
      label: fill(g.ownerInactiveOption, { name: inLang(ownerUnit.name) }),
    },
  );
  const ownerInactive = ownerOptions.some(
    (o) => o.inactive && o.id === ownerUnitId,
  );

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

  // A near miss or a hazard harmed nobody, so it has no harm level to set and
  // cannot be a sentinel event; the API refuses anything else.
  const noHarm = incident.type !== "incident";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { harmLevel, isSentinel, categoryId, assignedTo } = readForm(
      e.currentTarget,
    );
    setBusy(true);
    say(null);
    try {
      const result = await api<Incident | { handedOff: true }>(
        `/incidents/${incident.id}/triage`,
        {
          method: "POST",
          body: {
            harmLevel: noHarm ? "none" : harmLevel,
            isSentinel: noHarm ? false : isSentinel === "on",
            categoryId,
            ownerUnitId,
            assignedTo: assignedTo || null,
            // What this page was looking at: refused if it changed since.
            revision: incident.revision,
          },
        },
      );
      // Handed to a department this user cannot see: there is no incident
      // to show any more, so back to the list (the form warned of this).
      if ("handedOff" in result) {
        setBusy(false);
        return router.push(`/${lang}/incidents`);
      }
      // Said before the incident is replaced: this form is then put away.
      say({
        kind: "ok",
        text: g.saved,
        at: "triage",
        revision: result.revision,
      });
      onChange(result);
    } catch (err) {
      if (isStale(err)) onStale();
      say({ kind: "error", text: explain(err, t.errors), at: "triage" });
    }
    setBusy(false);
  }

  return (
    <Panel title={incident.status === "new" ? g.title : g.retitle}>
      <form onSubmit={submit} className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted">{g.help}</p>
        {!noHarm && (
          <>
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
          </>
        )}
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
        <Field
          label={g.ownerUnit}
          help={ownerInactive ? g.ownerInactive : undefined}
        >
          <select
            // `required` does not refuse a disabled option, so this does.
            ref={(select) => {
              select?.setCustomValidity(ownerInactive ? g.ownerInactive : "");
            }}
            required
            value={ownerUnitId}
            onChange={(e) => setOwnerUnitId(e.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              {t.form.choose}
            </option>
            {ownerOptions.map((u) => (
              <option key={u.id} value={u.id} disabled={u.inactive}>
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
                {/* An option holds no elements, so each name is isolated
                    with U+2068 … U+2069 to keep its own direction. */}
                {[inLang(p.name), p.orgUnitId && unitNames.get(p.orgUnitId)]
                  .filter(Boolean)
                  .map((part) => `\u2068${part}\u2069`)
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
  );
}

/** The status changes the API offers this user for this incident now. */
function StatusActions({ t, incident, onChange, onStale, message, say }: Part) {
  // Which of the offered moves was picked, by its place in the list.
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const a = t.actions;
  const { moves } = incident;
  const move = chosen === null ? undefined : moves[chosen];

  // Wording only, by the kind of move the API names. A kind this app has
  // no words for yet (added to the API since) is still offered, as
  // "Change status to …".
  const label = (m: StatusMove) =>
    wordFor(
      a.kinds,
      m.kind,
      fill(a.moveTo, { status: wordFor(t.status, m.to, t.statusOther) }),
    );
  const noteLabel = (m: StatusMove) =>
    wordFor(a.note, m.kind, m.noteRequired ? a.note.required : a.note.optional);
  // What the move means, for the ones that are not said by their name.
  const help = (m: StatusMove) => wordFor(a.help, m.kind, "");
  // Why a closure was sent back, or its request withdrawn, is for the
  // people handling the incident; every other note is on the reporter's
  // timeline. (The API withholds them; this only says so beforehand.)
  const noteHelp = (m: StatusMove) =>
    m.kind === "send_back" || m.kind === "withdraw"
      ? a.noteHelpInternal
      : a.noteHelp;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!move) return;
    const { note } = readForm(e.currentTarget);
    setBusy(true);
    say(null);
    try {
      const result = await api<Incident>(`/incidents/${incident.id}/status`, {
        method: "POST",
        body: {
          to: move.to,
          // Two moves can lead to the same status: this says which is meant.
          kind: move.kind,
          note: note || null,
          revision: incident.revision,
        },
      });
      // Said before the incident is replaced: this panel then starts again,
      // with the moves open from the new status and an empty note.
      say({
        kind: "ok",
        text: a.done,
        at: "status",
        revision: result.revision,
      });
      onChange(result);
    } catch (err) {
      if (isStale(err)) {
        setChosen(null);
        onStale();
      }
      say({ kind: "error", text: explain(err, t.errors), at: "status" });
    }
    setBusy(false);
  }

  return (
    <Panel title={a.title}>
      <div className="flex flex-col gap-4 p-4">
        {!move && (
          <div className="flex flex-wrap gap-2">
            {moves.map((m, index) => (
              <Button
                // Two moves can lead to the same status.
                key={`${m.kind}:${index}`}
                variant="secondary"
                onClick={() => {
                  say(null);
                  setChosen(index);
                }}
              >
                {label(m)}
              </Button>
            ))}
          </div>
        )}
        {move && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <p className="text-sm font-medium">{label(move)}</p>
              {help(move) && (
                <p className="mt-1 text-sm text-muted">{help(move)}</p>
              )}
            </div>
            <Field label={noteLabel(move)} help={noteHelp(move)}>
              <textarea
                name="note"
                rows={3}
                maxLength={2000}
                required={move.noteRequired}
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
