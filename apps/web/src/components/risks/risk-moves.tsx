"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { SignaturePrompt } from "@/components/signing/signature-prompt";
import { useSession } from "@/components/shell/session";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { api } from "@/lib/api";
import { fill } from "@/lib/format";
import { todayIn } from "@/lib/policies";
import {
  actionStrengths,
  controlKinds,
  effectivenessLevels,
  hierarchies,
  reviewOutcomes,
  treatments,
  type Action,
  type Control,
  type Move,
  type RatingKind,
  type RiskAnswer,
  type RiskList,
} from "@/lib/risks";
import { Notice } from "./bits";
import { committeesAbove, usePeople, type RiskContext } from "./context";
import {
  DayBox,
  MoveForm,
  TextBox,
  localizedOf,
  textOf,
} from "./move-form";
import { RatingPicker, readRating } from "./rating";
import type { RisksText } from "./types";

/** The moves that open a form here; the rest are links or are offered in place. */
export type FormMove =
  | Exclude<Move, "edit" | "correct">
  | "edit_control";

type Props = { c: RiskContext; onClose: () => void };

/** The words of a signature on a risk. */
export const signatureWords = (t: RisksText) => ({
  ...t.signature,
  wrongPassword: t.errors.wrong_password,
  passwordLocked: t.errors.password_locked,
  pinLocked: t.errors.signing_pin_locked,
  cancel: t.cancel,
});

function useLocales() {
  return useSession().tenant.locales;
}

function common(c: RiskContext, onClose: () => void) {
  return {
    t: c.t,
    onDone: c.adopt,
    onClose,
    onStale: () => c.reload(true),
    explain: c.explain,
  };
}

const post = (path: string, body: unknown) =>
  api<RiskAnswer>(path, { method: "POST", body });

// While the subscription is suspended, only the current rating stays open.
const rateKinds = (c: RiskContext): RatingKind[] =>
  c.suspended ? ["current"] : ["current", "inherent", "target"];

/**
 * A document in force to link a control to, while the documents module is
 * on: found by its number or title.
 */
function DocumentPicker({
  c,
  value,
  onChange,
}: {
  c: RiskContext;
  value: { id: string; label: string } | null;
  onChange: (next: { id: string; label: string } | null) => void;
}) {
  const { t } = c;
  const k = t.controls;
  const [found, setFound] = useState<{ id: string; label: string }[] | null>(null);
  async function look(q: string) {
    try {
      const list = await api<{
        items: { id: string; number: string; title: Record<string, string | undefined> }[];
      }>(
        `/policies/documents?${new URLSearchParams({ q: q.trim(), status: "active", pageSize: "20" })}`,
      );
      setFound(
        list.items.map((d) => ({ id: d.id, label: `${d.number} · \u2068${c.inLang(d.title)}\u2069` })),
      );
    } catch {
      setFound([]);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Field label={k.document} help={k.documentHelp}>
        <input
          name="documentQ"
          type="search"
          dir="auto"
          maxLength={200}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void look(e.currentTarget.value);
            }
          }}
          onBlur={(e) => e.currentTarget.value.trim() && void look(e.currentTarget.value)}
          className={`${inputClass} sm:max-w-md`}
        />
      </Field>
      {found && found.length === 0 && <p className="text-sm text-muted">{k.noDocument}</p>}
      <Field label={k.linked}>
        <select
          value={value?.id ?? ""}
          onChange={(e) =>
            onChange(
              [...(found ?? []), ...(value ? [value] : [])].find((d) => d.id === e.target.value) ?? null,
            )
          }
          className={`${inputClass} sm:max-w-md`}
        >
          <option value="">{t.none}</option>
          {value && !found?.some((d) => d.id === value.id) && (
            <option value={value.id}>{value.label}</option>
          )}
          {(found ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

export function RateForm({ c, onClose }: Props) {
  const { t, risk, matrix } = c;
  const locales = useLocales();
  const kinds = rateKinds(c);
  const [kind, setKind] = useState<RatingKind>(kinds[0]);
  if (!matrix) return <Notice>{t.noMatrix}</Notice>;
  return (
    <MoveForm
      {...common(c, onClose)}
      title={t.moves.rate}
      confirm={t.rating.save}
      onSubmit={(data) => {
        const rating = readRating(data, "r", locales);
        return post(`/risks/${risk.id}/ratings`, {
          revision: risk.revision,
          kind,
          ...rating,
        });
      }}
    >
      {kinds.length > 1 && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t.rating.which}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {kinds.map((k) => (
              <label key={k} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="accent-accent"
                />
                {t.ratingKind[k]}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <RatingPicker
        key={kind}
        t={t}
        lang={c.lang}
        matrix={matrix}
        prefix="r"
        initial={risk[kind]}
        word={c.word}
      />
    </MoveForm>
  );
}

/** A control: added, or changed. Switching one off asks why. */
export function ControlForm({
  c,
  onClose,
  control,
}: Props & { control?: Control }) {
  const { t, risk } = c;
  const locales = useLocales();
  const people = usePeople(risk.people);
  const [off, setOff] = useState(false);
  const [document, setDocument] = useState<{ id: string; label: string } | null>(
    control?.documentId
      ? {
          id: control.documentId,
          label: control.document?.number
            ? `${control.document.number} · \u2068${c.inLang(control.document.title)}\u2069`
            : t.document.restricted,
        }
      : null,
  );
  const k = t.controls;
  return (
    <MoveForm
      {...common(c, onClose)}
      title={control ? k.edit : t.moves.add_control}
      confirm={control ? t.save : k.add}
      onDone={() => void c.reload()}
      onSubmit={(data) => {
        const body = {
          description: localizedOf(data, "description", locales),
          kind: textOf(data, "kind"),
          hierarchy: textOf(data, "hierarchy") ?? null,
          ownerId: textOf(data, "ownerId"),
          effectiveness: textOf(data, "effectiveness"),
          assessedOn: textOf(data, "assessedOn") ?? null,
          documentId: c.policiesOn ? (document?.id ?? null) : (control?.documentId ?? null),
        };
        return control
          ? api(`/risks/${risk.id}/controls/${control.id}`, {
              method: "PATCH",
              body: {
                revision: control.revision,
                ...body,
                ...(off ? { active: false, reason: textOf(data, "reason") } : {}),
              },
            })
          : api(`/risks/${risk.id}/controls`, {
              method: "POST",
              body: { revision: risk.revision, ...body },
            });
      }}
    >
      <p className="text-sm text-muted">{t.form.noPersonalDetails}</p>
      <LocalizedField
        label={k.description}
        name="description"
        locales={locales}
        multiline
        maxLength={2000}
        value={control?.description}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={k.kindLabel}>
          <select name="kind" required defaultValue={control?.kind ?? ""} className={inputClass}>
            <option value="" disabled>
              {t.choose}
            </option>
            {controlKinds.map((v) => (
              <option key={v} value={v}>
                {t.control.kind[v]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={k.hierarchyLabel} help={k.hierarchyHelp}>
          <select name="hierarchy" defaultValue={control?.hierarchy ?? ""} className={inputClass}>
            <option value="">{t.none}</option>
            {hierarchies.map((v) => (
              <option key={v} value={v}>
                {t.control.hierarchy[v]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={k.owner}>
          <select
            name="ownerId"
            required
            defaultValue={control?.ownerId ?? ""}
            className={inputClass}
          >
            <option value="" disabled>
              {t.choose}
            </option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {c.inLang(p.name) || t.someone}
              </option>
            ))}
          </select>
        </Field>
        <Field label={k.effectiveness}>
          <select
            name="effectiveness"
            defaultValue={control?.effectiveness ?? "not_assessed"}
            className={inputClass}
          >
            {effectivenessLevels.map((v) => (
              <option key={v} value={v}>
                {t.control.effectiveness[v]}
              </option>
            ))}
          </select>
        </Field>
        <DayBox
          label={k.assessedOn}
          help={k.assessedOnHelp}
          name="assessedOn"
          max={todayIn(c.timeZone)}
          value={control?.assessedOn}
        />
      </div>
      {c.policiesOn && <DocumentPicker c={c} value={document} onChange={setDocument} />}
      {control && (
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={off}
            onChange={(e) => setOff(e.target.checked)}
            className="size-4 accent-accent"
          />
          {k.switchOff}
        </label>
      )}
      {off && <TextBox label={k.switchOffReason} name="reason" />}
    </MoveForm>
  );
}

export function ReviewForm({ c, onClose }: Props) {
  const { t, risk, matrix } = c;
  const locales = useLocales();
  const [outcome, setOutcome] = useState<(typeof reviewOutcomes)[number]>("no_change");
  const [rateTarget, setRateTarget] = useState(false);
  const [forCommittee, setForCommittee] = useState(false);
  const r = t.reviewForm;
  if (!matrix) return <Notice>{t.noMatrix}</Notice>;
  const controls = risk.controls.filter((x) => x.active);
  const committee = risk.escalatedToCommitteeId;
  return (
    <MoveForm
      {...common(c, onClose)}
      title={t.moves.review}
      confirm={r.save}
      onSubmit={(data) => {
        const changed = controls
          .map((x) => ({ controlId: x.id, effectiveness: String(data.get(`control-${x.id}`) ?? "") }))
          .filter((x, i) => x.effectiveness && x.effectiveness !== controls[i].effectiveness);
        const target = rateTarget ? readRating(data, "tg", locales) : null;
        const treatment = textOf(data, "treatment");
        const next = textOf(data, "nextReviewOn");
        return post(`/risks/${risk.id}/reviews`, {
          revision: risk.revision,
          outcome,
          comment: textOf(data, "comment") ?? "",
          current: readRating(data, "cr", locales),
          ...(target ? { target } : {}),
          ...(changed.length > 0 ? { controls: changed } : {}),
          ...(!forCommittee && treatment !== (risk.treatment ?? undefined)
            ? { treatment: treatment ?? null }
            : {}),
          ...(next ? { nextReviewOn: next } : {}),
          ...(forCommittee && committee ? { committeeId: committee } : {}),
        });
      }}
    >
      {committee && (
        <label className="flex min-h-9 items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={forCommittee}
            onChange={(e) => setForCommittee(e.target.checked)}
            className="mt-1 size-4 accent-accent"
          />
          {fill(r.forCommittee, { committee: c.name.committee(committee) })}
        </label>
      )}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{r.outcome}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {reviewOutcomes.map((o) => (
            <label key={o} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="radio"
                name="outcome"
                value={o}
                checked={outcome === o}
                onChange={() => setOutcome(o)}
                className="accent-accent"
              />
              {t.review.outcome[o]}
            </label>
          ))}
        </div>
      </fieldset>
      <TextBox label={t.review.comment} help={t.form.noPersonalDetails} name="comment" max={4000} rows={4} />
      <RatingPicker
        t={t}
        lang={c.lang}
        matrix={matrix}
        prefix="cr"
        initial={risk.current}
        word={c.word}
        heading={r.current}
      />
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={rateTarget}
          onChange={(e) => setRateTarget(e.target.checked)}
          className="size-4 accent-accent"
        />
        {r.rateTarget}
      </label>
      {rateTarget && (
        <RatingPicker
          t={t}
          lang={c.lang}
          matrix={matrix}
          prefix="tg"
          initial={risk.target}
          word={c.word}
          heading={t.ratingKind.target}
        />
      )}
      {controls.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{r.controls}</legend>
          {controls.map((x) => (
            <Field key={x.id} label={c.inLang(x.description)}>
              <select
                name={`control-${x.id}`}
                defaultValue={x.effectiveness}
                className={`${inputClass} sm:max-w-72`}
              >
                {effectivenessLevels.map((v) => (
                  <option key={v} value={v}>
                    {t.control.effectiveness[v]}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!forCommittee && (
          <Field label={t.fields.treatment} help={r.treatmentHelp}>
            <select name="treatment" defaultValue={risk.treatment ?? ""} className={inputClass}>
              <option value="">{t.none}</option>
              {treatments.map((v) => (
                <option key={v} value={v}>
                  {t.treatment[v]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <DayBox
          label={r.nextReviewOn}
          help={r.nextReviewHelp}
          name="nextReviewOn"
          min={todayIn(c.timeZone)}
        />
      </div>
    </MoveForm>
  );
}

/** An action on the risk: its fields, for adding one or changing it. */
export function ActionFields({
  c,
  action,
  people,
}: {
  c: Pick<RiskContext, "t" | "inLang" | "timeZone">;
  action?: Action;
  people: { id: string; name: Record<string, string | undefined> }[];
}) {
  const { t } = c;
  const session = useSession();
  const locales = session.tenant.locales;
  const a = t.actions;
  const progressOnly = action?.editable === "progress";
  return (
    <>
      {!progressOnly && (
        <>
          <LocalizedField
            label={a.fields.title}
            name="title"
            locales={locales}
            required={session.tenant.defaultLocale}
            maxLength={300}
            value={action?.title}
          />
          <LocalizedField
            label={a.fields.description}
            name="description"
            locales={locales}
            multiline
            maxLength={4000}
            value={action?.description}
          />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!progressOnly && (
          <Field label={a.fields.owner}>
            <select
              name="ownerId"
              required
              defaultValue={action?.ownerId ?? ""}
              className={inputClass}
            >
              <option value="" disabled>
                {t.choose}
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {c.inLang(p.name) || t.someone}
                </option>
              ))}
            </select>
          </Field>
        )}
        <DayBox
          label={a.fields.dueOn}
          name="dueOn"
          required
          min={todayIn(c.timeZone)}
          value={action?.dueOn}
        />
        {!progressOnly && (
          <>
            <Field label={a.fields.strength} help={a.fields.strengthHelp}>
              <select
                name="strength"
                required
                defaultValue={action?.strength ?? ""}
                className={inputClass}
              >
                <option value="" disabled>
                  {t.choose}
                </option>
                {actionStrengths.map((v) => (
                  <option key={v} value={v}>
                    {a.strength[v]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.controls.hierarchyLabel}>
              <select
                name="hierarchy"
                defaultValue={action?.hierarchy ?? ""}
                className={inputClass}
              >
                <option value="">{t.none}</option>
                {hierarchies.map((v) => (
                  <option key={v} value={v}>
                    {t.control.hierarchy[v]}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>
    </>
  );
}

export function AddActionForm({ c, onClose }: Props) {
  const { t, risk } = c;
  const locales = useLocales();
  const people = usePeople(risk.people);
  return (
    <MoveForm
      {...common(c, onClose)}
      title={t.actions.add}
      confirm={t.actions.add}
      onDone={() => void c.reload()}
      onSubmit={(data) =>
        api(`/risks/${risk.id}/actions`, {
          method: "POST",
          body: {
            revision: risk.revision,
            title: localizedOf(data, "title", locales),
            description: localizedOf(data, "description", locales),
            ownerId: textOf(data, "ownerId"),
            dueOn: textOf(data, "dueOn"),
            strength: textOf(data, "strength"),
            hierarchy: textOf(data, "hierarchy") ?? null,
          },
        })
      }
    >
      <p className="text-sm text-muted">{t.form.noPersonalDetails}</p>
      <ActionFields c={c} people={people} />
    </MoveForm>
  );
}

export function EscalateForm({ c, onClose }: Props) {
  const { t, risk } = c;
  const choices = committeesAbove(
    c.settings?.committees ?? [],
    c.matrix,
    risk.escalatedToCommitteeId,
  );
  return (
    <MoveForm
      {...common(c, onClose)}
      title={t.moves.escalate}
      confirm={t.moves.escalate}
      onSubmit={(data) =>
        post(`/risks/${risk.id}/escalate`, {
          revision: risk.revision,
          committeeId: textOf(data, "committeeId"),
          reason: textOf(data, "reason"),
        })
      }
    >
      {choices.length === 0 ? (
        <Notice>{t.escalation.noneAbove}</Notice>
      ) : (
        <Field label={t.escalation.committee}>
          <select name="committeeId" required defaultValue="" className={`${inputClass} sm:max-w-md`}>
            <option value="" disabled>
              {t.choose}
            </option>
            {choices.map((x) => (
              <option key={x.id} value={x.id}>
                {c.inLang(x.name)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <TextBox label={t.escalation.reason} help={t.form.noPersonalDetails} name="reason" />
    </MoveForm>
  );
}

/** A form that asks only why: taking it off a list, rejecting, withdrawing. */
export function ReasonForm({
  c,
  onClose,
  title,
  label,
  help,
  confirm,
  path,
  field = "reason",
  intro,
}: Props & {
  title: string;
  label: string;
  help?: string;
  confirm: string;
  path: string;
  field?: "reason" | "comment";
  intro?: string;
}) {
  const { risk } = c;
  return (
    <MoveForm
      {...common(c, onClose)}
      title={title}
      intro={intro}
      confirm={confirm}
      onSubmit={(data) =>
        post(`/risks/${risk.id}/${path}`, {
          revision: risk.revision,
          [field]: textOf(data, field),
        })
      }
    >
      <TextBox label={label} help={help ?? c.t.form.noPersonalDetails} name={field} max={field === "comment" ? 2000 : 1000} />
    </MoveForm>
  );
}

export function AcceptProposalForm({ c, onClose }: Props) {
  const { t, risk, matrix } = c;
  const locales = useLocales();
  const people = usePeople(risk.people);
  const [withInherent, setWithInherent] = useState(!!c.settings?.inherentRequired);
  const [withTarget, setWithTarget] = useState(false);
  if (!matrix) return <Notice>{t.noMatrix}</Notice>;
  return (
    <MoveForm
      {...common(c, onClose)}
      title={t.moves.accept_proposal}
      intro={t.proposal.acceptIntro}
      confirm={t.moves.accept_proposal}
      onSubmit={(data) => {
        const inherent = withInherent ? readRating(data, "ih", locales) : null;
        const target = withTarget ? readRating(data, "tg", locales) : null;
        return post(`/risks/${risk.id}/proposal/accept`, {
          revision: risk.revision,
          ownerId: textOf(data, "ownerId"),
          current: readRating(data, "cr", locales),
          ...(inherent ? { inherent } : {}),
          ...(target ? { target } : {}),
        });
      }}
    >
      <Field label={t.fields.owner}>
        <select
          name="ownerId"
          required
          defaultValue={risk.ownerId}
          className={`${inputClass} sm:max-w-md`}
        >
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {c.inLang(p.name) || t.someone}
            </option>
          ))}
        </select>
      </Field>
      <RatingPicker
        t={t}
        lang={c.lang}
        matrix={matrix}
        prefix="cr"
        initial={risk.current}
        word={c.word}
        heading={t.ratingKind.current}
      />
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={withInherent}
          onChange={(e) => setWithInherent(e.target.checked)}
          className="size-4 accent-accent"
        />
        {c.settings?.inherentRequired ? t.form.inherentRequired : t.form.withInherent}
      </label>
      {withInherent && (
        <RatingPicker
          t={t}
          lang={c.lang}
          matrix={matrix}
          prefix="ih"
          initial={risk.inherent}
          word={c.word}
          heading={t.ratingKind.inherent}
        />
      )}
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={withTarget}
          onChange={(e) => setWithTarget(e.target.checked)}
          className="size-4 accent-accent"
        />
        {t.form.withTarget}
      </label>
      {withTarget && (
        <RatingPicker
          t={t}
          lang={c.lang}
          matrix={matrix}
          prefix="tg"
          initial={risk.target}
          word={c.word}
          heading={t.ratingKind.target}
        />
      )}
    </MoveForm>
  );
}

/** Find an incident by its reference, then link it. */
export function LinkIncidentForm({ c, onClose }: Props) {
  const { t, risk } = c;
  const i = t.incidents;
  const [found, setFound] = useState<
    { id: string; reference: string }[] | null
  >(null);
  const [looking, setLooking] = useState(false);
  const [chosen, setChosen] = useState("");

  async function look(q: string) {
    if (!q.trim()) return;
    setLooking(true);
    try {
      const list = await api<{ items: { id: string; reference: string }[] }>(
        `/incidents?${new URLSearchParams({ q: q.trim(), pageSize: "10" })}`,
      );
      setFound(list.items);
      setChosen(list.items[0]?.id ?? "");
    } catch {
      setFound([]);
    }
    setLooking(false);
  }

  return (
    <MoveForm
      {...common(c, onClose)}
      title={i.link}
      confirm={i.link}
      onDone={() => void c.reload()}
      onSubmit={(data) =>
        api(`/risks/${risk.id}/incident-links`, {
          method: "POST",
          body: {
            incidentId: chosen,
            kind: textOf(data, "kind"),
            ...(textOf(data, "note") ? { note: textOf(data, "note") } : {}),
          },
        })
      }
    >
      <div className="flex items-end gap-2 sm:max-w-md">
        <div className="min-w-0 flex-1">
          <Field label={i.find} help={i.findHelp}>
            <input
              name="q"
              type="search"
              dir="ltr"
              maxLength={60}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void look(e.currentTarget.value);
                }
              }}
              className={inputClass}
            />
          </Field>
        </div>
        <button
          type="button"
          aria-label={i.findButton}
          title={i.findButton}
          disabled={looking}
          onClick={(e) => {
            const input = e.currentTarget.form?.elements.namedItem("q");
            if (input instanceof HTMLInputElement) void look(input.value);
          }}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-md border border-line px-3 hover:bg-background"
        >
          <Search className="size-4" aria-hidden />
        </button>
      </div>
      {found && found.length === 0 && <p className="text-sm text-muted">{i.noneFound}</p>}
      {found && found.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{i.choose}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {found.map((x) => (
              <label key={x.id} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="incident"
                  value={x.id}
                  checked={chosen === x.id}
                  onChange={() => setChosen(x.id)}
                  required
                  className="accent-accent"
                />
                <bdi dir="ltr">{x.reference}</bdi>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{i.kindLabel}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(["supports", "raised"] as const).map((k) => (
            <label key={k} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                value={k}
                defaultChecked={k === "supports"}
                className="accent-accent"
              />
              {i.kind[k]}
            </label>
          ))}
        </div>
      </fieldset>
      <TextBox label={i.note} name="note" required={false} />
    </MoveForm>
  );
}

export function AcceptanceForm({ c, onClose }: Props) {
  const { t, risk } = c;
  const locales = useLocales();
  const a = t.acceptance;
  const today = todayIn(c.timeZone);
  const months = c.settings?.acceptanceMaxMonths ?? 12;
  const latest = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  })();
  return (
    <MoveForm
      {...common(c, onClose)}
      title={a.ask}
      intro={fill(a.intro, {
        band: risk.current ? c.word(risk.current.band) : "",
        tolerance: c.word(risk.tolerance),
      })}
      confirm={a.ask}
      onSubmit={(data) =>
        post(`/risks/${risk.id}/acceptance`, {
          revision: risk.revision,
          rationale: localizedOf(data, "rationale", locales),
          conditions: localizedOf(data, "conditions", locales),
          until: textOf(data, "until"),
        })
      }
    >
      <p className="text-sm text-muted">{t.form.noPersonalDetails}</p>
      <LocalizedField label={a.rationale} name="rationale" locales={locales} multiline maxLength={4000} />
      <LocalizedField label={a.conditions} name="conditions" locales={locales} multiline maxLength={4000} />
      <DayBox
        label={a.until}
        help={fill(a.untilHelp, { months: c.months(months) })}
        name="until"
        required
        min={today}
        max={latest}
      />
      <p className="text-xs text-muted">{a.fixed}</p>
    </MoveForm>
  );
}

/** A signature on a step of an acceptance or a closure. */
export function SignStepForm({
  c,
  onClose,
  subject,
}: Props & { subject: "acceptance" | "closure" }) {
  const { t, risk } = c;
  return (
    <SignaturePrompt
      words={signatureWords(t)}
      intro={
        <>
          <p className="font-medium">{t.steps.approveTitle[subject]}</p>
          <p className="mt-1">{t.steps.approveIntro[subject]}</p>
        </>
      }
      confirm={t.steps.approve}
      comment={{ label: t.steps.comment }}
      explainError={c.explain}
      onCancel={onClose}
      submit={async (password, comment) => {
        const answer = await post(`/risks/${risk.id}/${subject}/approve`, {
          revision: risk.revision,
          password,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        });
        c.adopt(answer);
        onClose();
      }}
    />
  );
}

/** Close the risk, or ask for its closure when a second signature is needed. */
export function CloseForm({ c, onClose, asks }: Props & { asks: boolean }) {
  const { t, risk } = c;
  const k = t.closure;
  const [found, setFound] = useState<RiskList["items"] | null>(null);
  const [merged, setMerged] = useState("");

  async function look(q: string) {
    if (!q.trim()) return;
    try {
      const list = await api<RiskList>(
        `/risks?${new URLSearchParams({ q: q.trim(), pageSize: "10" })}`,
      );
      setFound(list.items.filter((x) => x.id !== risk.id));
    } catch {
      setFound([]);
    }
  }

  return (
    <MoveForm
      {...common(c, onClose)}
      title={asks ? k.request : k.close}
      intro={asks ? k.requestIntro : k.closeIntro}
      confirm={asks ? k.request : k.close}
      onSubmit={(data) =>
        post(`/risks/${risk.id}/close`, {
          revision: risk.revision,
          reason: textOf(data, "reason"),
          ...(merged ? { mergedIntoId: merged } : {}),
        })
      }
    >
      <TextBox label={k.reason} help={t.form.noPersonalDetails} name="reason" />
      <details className="rounded-md border border-line bg-background p-3">
        <summary className="cursor-pointer text-sm font-medium">{k.merge}</summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field label={k.mergeFind}>
            <input
              name="mergeQ"
              type="search"
              dir="auto"
              maxLength={200}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void look(e.currentTarget.value);
                }
              }}
              onBlur={(e) => void look(e.currentTarget.value)}
              className={`${inputClass} sm:max-w-md`}
            />
          </Field>
          {found && found.length === 0 && <p className="text-sm text-muted">{t.list.empty}</p>}
          {found && found.length > 0 && (
            <Field label={k.mergeInto}>
              <select
                value={merged}
                onChange={(e) => setMerged(e.target.value)}
                className={`${inputClass} sm:max-w-md`}
              >
                <option value="">{t.none}</option>
                {found.map((x) => (
                  <option key={x.id} value={x.id}>
                    {`${x.reference} · ⁨${c.inLang(x.title)}⁩`}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </details>
    </MoveForm>
  );
}

export function ReopenForm({ c, onClose }: Props) {
  const { t, risk, matrix } = c;
  const locales = useLocales();
  if (!matrix) return <Notice>{t.noMatrix}</Notice>;
  return (
    <MoveForm
      {...common(c, onClose)}
      title={t.closure.reopen}
      intro={t.closure.reopenIntro}
      confirm={t.closure.reopen}
      onSubmit={(data) =>
        post(`/risks/${risk.id}/reopen`, {
          revision: risk.revision,
          reason: textOf(data, "reason"),
          current: readRating(data, "cr", locales),
        })
      }
    >
      <TextBox label={t.closure.reopenReason} help={t.form.noPersonalDetails} name="reason" />
      <RatingPicker
        t={t}
        lang={c.lang}
        matrix={matrix}
        prefix="cr"
        initial={risk.current}
        word={c.word}
        heading={t.ratingKind.current}
      />
    </MoveForm>
  );
}

/** The form for one move, or null for a move offered elsewhere. */
export function MoveFormFor({
  c,
  move,
  onClose,
}: Props & { move: FormMove }) {
  const { t } = c;
  switch (move) {
    case "rate":
      return <RateForm c={c} onClose={onClose} />;
    case "add_control":
      return <ControlForm c={c} onClose={onClose} />;
    case "review":
      return <ReviewForm c={c} onClose={onClose} />;
    case "add_action":
      return <AddActionForm c={c} onClose={onClose} />;
    case "escalate":
      return <EscalateForm c={c} onClose={onClose} />;
    case "de_escalate":
      return (
        <ReasonForm
          c={c}
          onClose={onClose}
          title={t.moves.de_escalate}
          intro={fill(t.escalation.deEscalateIntro, {
            committee: c.name.committee(c.risk.escalatedToCommitteeId),
          })}
          label={t.escalation.deEscalateReason}
          confirm={t.moves.de_escalate}
          path="de-escalate"
        />
      );
    case "accept_proposal":
      return <AcceptProposalForm c={c} onClose={onClose} />;
    case "reject_proposal":
      return (
        <ReasonForm
          c={c}
          onClose={onClose}
          title={t.moves.reject_proposal}
          label={t.proposal.rejectReason}
          confirm={t.moves.reject_proposal}
          path="proposal/reject"
        />
      );
    case "link_incident":
      return <LinkIncidentForm c={c} onClose={onClose} />;
    case "request_acceptance":
      return <AcceptanceForm c={c} onClose={onClose} />;
    case "withdraw_acceptance":
      return (
        <ReasonForm
          c={c}
          onClose={onClose}
          title={t.acceptance.withdraw}
          label={t.acceptance.withdrawReason}
          confirm={t.acceptance.withdraw}
          path="acceptance/withdraw"
        />
      );
    case "approve_acceptance":
      return <SignStepForm c={c} onClose={onClose} subject="acceptance" />;
    case "approve_closure":
      return <SignStepForm c={c} onClose={onClose} subject="closure" />;
    case "return_acceptance":
    case "return_closure": {
      const subject = move === "return_acceptance" ? "acceptance" : "closure";
      return (
        <ReasonForm
          c={c}
          onClose={onClose}
          title={t.steps.returnTitle[subject]}
          label={t.steps.returnComment}
          help={t.steps.returnHelp}
          confirm={t.steps.return}
          path={`${subject}/return`}
          field="comment"
        />
      );
    }
    case "close":
      return <CloseForm c={c} onClose={onClose} asks={false} />;
    case "request_closure":
      return <CloseForm c={c} onClose={onClose} asks />;
    case "reopen":
      return <ReopenForm c={c} onClose={onClose} />;
    default:
      return null;
  }
}
