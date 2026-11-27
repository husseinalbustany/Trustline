"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { can, useSession } from "@/components/shell/session";
import {
  hasModule,
  ReadOnlyFieldset,
  useReadOnly,
  useSubscriptionRefusal,
} from "@/components/shell/subscription";
import { features } from "@/config/modules";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, statusOf } from "@/lib/api";
import { fill } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import { pick, readForm } from "@/lib/localized";
import {
  childType,
  parentType,
  unitTypes,
  type UnitType,
} from "@/lib/org-units";
import type { AdminProps } from "./types";
import { UnitPoster, UnitReporting } from "./unit-reporting";

type Message = { kind: "ok" | "error"; text: string; at?: "status" };

const fixedClass = `${inputClass} disabled:bg-surface disabled:text-muted`;

/** Codes are capitals: uppercases what is typed, keeping the caret in place. */
function uppercase(e: FormEvent<HTMLInputElement>) {
  const input = e.currentTarget;
  const value = input.value.toUpperCase();
  // Left alone while a keyboard is still composing a character.
  if ((e.nativeEvent as InputEvent).isComposing || value === input.value) {
    return;
  }
  const { selectionStart, selectionEnd } = input;
  input.value = value;
  input.setSelectionRange(selectionStart, selectionEnd);
}

/**
 * Adds a facility, department or unit, or edits one.
 *
 * `id` is the unit to edit, or on an "add" page the unit to add under. It
 * comes from the server page, not from `useParams()`: a page kept mounted
 * behind another one is re-rendered with that one's params, and this form
 * decides what it shows from the id.
 */
export function OrgUnitForm({
  lang,
  t,
  mode,
  id,
  posterLines,
}: AdminProps & {
  mode: "new" | "edit";
  id?: string;
  /**
   * The line printed under a unit's QR code, in each interface language:
   * the poster is written in the hospital's languages, not the reader's.
   */
  posterLines?: Record<string, string>;
}) {
  const router = useRouter();
  const session = useSession();
  const allowed = can(session, "organization.manage");
  const [units, setUnits] = useState<OrgUnit[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The type picked in the form, when it is not the one the page opened with.
  const [pickedType, setPickedType] = useState<UnitType | null>(null);
  const [visit, setVisit] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const languages = session.tenant;
  const o = t.organization;
  const f = o.form;
  const listPath = `/${lang}/admin/organization`;
  const nameOf = (unit: OrgUnit) =>
    pick(unit.name, lang, languages.defaultLocale);

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    // Editing needs the units that are switched off too: the one being
    // edited may be one of them. Something new only goes under active ones.
    api<OrgUnit[]>(
      mode === "edit" ? "/org-units?includeInactive=true" : "/org-units",
    )
      .then((list) => {
        if (!current) return;
        setUnits(list);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 403 ? t.noAccess : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [allowed, mode, t]);

  // Visited pages stay mounted. A note about the last save must not be
  // waiting when this page is shown again, and an "add" page starts each
  // time from what the button that led here said, not from an old draft.
  useLayoutEffect(
    () => () => {
      setMessage(null);
      if (mode === "new") {
        setPickedType(null);
        setVisit((n) => n + 1);
      }
    },
    [mode],
  );

  const refusal = useSubscriptionRefusal();
  const readOnly = useReadOnly();
  const explain = (err: unknown) => {
    const refused = refusal(err);
    if (refused) return refused;
    const code = codeOf(err);
    if (code && code in o.errors) {
      return o.errors[code as keyof typeof o.errors];
    }
    const status = statusOf(err);
    if (status === 403) return t.noAccess;
    if (status === 404) return o.errors.notFound;
    return status === 400 ? o.errors.invalid : o.errors.generic;
  };

  // `at` says where a failure is shown: beside the part that was acted on.
  async function run(work: () => Promise<void>, at?: "status") {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      setMessage({ kind: "error", text: explain(err), at });
    }
    setBusy(false);
  }

  const state = (text: string, back = true) => (
    <>
      <EmptyState>{text}</EmptyState>
      {back && (
        <p className="text-center text-sm">
          <Link href={listPath} className="text-accent hover:underline">
            {o.back}
          </Link>
        </p>
      )}
    </>
  );
  if (!allowed) return state(t.noAccess, false);
  if (problem) return state(problem);
  if (!units) return state(t.loading, false);

  // On the edit page, the unit itself; on an "add" page, where to add.
  const routeUnit = units.find((u) => u.id === id);
  const unit = mode === "edit" ? routeUnit : undefined;
  if (mode === "edit" && !unit) return state(o.notFound);
  // What the page opened to add: under a unit, the level below it. Nothing,
  // when that unit is missing, switched off or already the lowest level.
  const under = mode === "new" ? routeUnit : undefined;
  const openedType = under ? childType[under.type] : id ? null : "facility";
  if (mode === "new" && !openedType) return state(f.parentMissing);
  const type: UnitType = unit?.type ?? pickedType ?? openedType ?? "facility";
  const above = parentType[type];

  const saved = (updated: OrgUnit) =>
    setUnits(units.map((u) => (u.id === updated.id ? updated : u)));

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { name, code, parentId } = readForm(form);
    void run(async () => {
      if (!unit) {
        await api("/org-units", {
          method: "POST",
          body: { type, code: String(code).toUpperCase(), name, parentId },
        });
        form.reset();
        setPickedType(null);
        router.push(listPath);
        return;
      }
      saved(
        await api<OrgUnit>(`/org-units/${unit.id}`, {
          method: "PATCH",
          body: { name, parentId },
        }),
      );
      setMessage({ kind: "ok", text: f.saved });
    });
  }

  const setActive = (active: boolean) =>
    run(async () => {
      saved(
        await api<OrgUnit>(`/org-units/${unit?.id}`, {
          method: "PATCH",
          body: { active },
        }),
      );
      setMessage({
        kind: "ok",
        text: active ? f.switchedOn : f.switchedOff,
        at: "status",
      });
    }, "status");

  // Where this type can sit. An active unit cannot go under one that is
  // switched off, so those are shown but cannot be chosen.
  const parentOption = (p: OrgUnit) => (
    <option key={p.id} value={p.id} disabled={!p.active && unit?.active}>
      {/* An option holds no elements, so the name is isolated with
          U+2068 … U+2069 (`fill` does the same) to keep its own direction. */}
      {p.active
        ? `\u2068${nameOf(p)}\u2069`
        : fill(o.inactiveNamed[p.type], { name: nameOf(p) })}
    </option>
  );
  const parents = units.filter((u) => u.type === above);
  let parentOptions: ReactNode = parents.map(parentOption);
  if (type === "unit") {
    // Departments in different facilities may share a name.
    parentOptions = units
      .filter((u) => u.type === "facility")
      .map((facility) => ({
        facility,
        departments: parents.filter((p) => p.parentId === facility.id),
      }))
      .filter((group) => group.departments.length > 0)
      .map(({ facility, departments }) => (
        <optgroup key={facility.id} label={`\u2068${nameOf(facility)}\u2069`}>
          {departments.map(parentOption)}
        </optgroup>
      ));
  }

  const note = (at?: "status") =>
    message &&
    message.at === at && (
      <p
        role={message.kind === "error" ? "alert" : "status"}
        className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
      >
        {message.text}
      </p>
    );

  // While the hospital takes reports without sign-in, a unit in use has its
  // own link and QR code. On paper the page is the poster and nothing else.
  const reporting =
    unit?.active &&
    hasModule(session, features.unitReporting) &&
    session.tenant.publicReporting &&
    posterLines
      ? { lang, t, unit, posterLines }
      : null;

  return (
    <>
      {reporting && <UnitPoster {...reporting} />}
      <div className={reporting ? "print:hidden" : undefined}>
        <PageHeader
          title={unit ? <bdi>{nameOf(unit)}</bdi> : o.add[type]}
          description={
            unit ? (
              <>
                {o.type[unit.type]} · <bdi dir="ltr">{unit.code}</bdi>
              </>
            ) : (
              f.newDescription
            )
          }
          actions={
            unit &&
            !unit.active && <Pill tone="neutral">{o.inactive[unit.type]}</Pill>
          }
        />

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <form
            key={unit?.id ?? visit}
            onSubmit={submit}
            className="flex flex-col gap-5 rounded-lg border border-line p-4 sm:p-6"
          >
            <ReadOnlyFieldset>
              <LocalizedField
                label={f.name}
                name="name"
                locales={languages.locales}
                required={languages.defaultLocale}
                value={unit?.name}
              />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={f.code} help={unit ? f.codeFixed : f.codeHelp}>
                  {unit ? (
                    <input
                      disabled
                      dir="ltr"
                      value={unit.code}
                      className={fixedClass}
                    />
                  ) : (
                    <input
                      name="code"
                      required
                      pattern="[A-Z0-9\-]{2,40}"
                      maxLength={40}
                      dir="ltr"
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      onInput={uppercase}
                      className={inputClass}
                    />
                  )}
                </Field>
                <Field label={f.type} help={unit ? f.typeFixed : f.typeHelp}>
                  {unit ? (
                    <input
                      disabled
                      value={o.type[type]}
                      className={fixedClass}
                    />
                  ) : (
                    <select
                      defaultValue={type}
                      onChange={(e) =>
                        setPickedType(e.target.value as UnitType)
                      }
                      className={inputClass}
                    >
                      {unitTypes.map((option) => {
                        const needs = parentType[option];
                        return (
                          <option
                            key={option}
                            value={option}
                            // Nothing to put it under yet.
                            disabled={
                              !!needs && !units.some((u) => u.type === needs)
                            }
                          >
                            {o.type[option]}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </Field>
                {above && (
                  <Field
                    label={f.parent[type as "department" | "unit"]}
                    help={unit ? f.parentHelp : undefined}
                  >
                    <select
                      // Another type sits under other units: start the choice again.
                      key={type}
                      name="parentId"
                      required
                      defaultValue={
                        unit?.parentId ??
                        (under?.type === above ? under.id : "")
                      }
                      className={inputClass}
                    >
                      <option value="" disabled>
                        {f.choose}
                      </option>
                      {parentOptions}
                    </select>
                  </Field>
                )}
              </div>

              {note()}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {unit ? f.save : o.add[type]}
                </Button>
                <Link
                  href={listPath}
                  className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground"
                >
                  {unit ? o.back : f.cancel}
                </Link>
              </div>
            </ReadOnlyFieldset>
          </form>

          {unit && (
            <div className="flex flex-col gap-6">
              <Panel title={f.status}>
                <div className="flex flex-col items-start gap-3 p-4">
                  <p className="text-sm text-muted">
                    {unit.active ? f.activeHelp : f.inactiveHelp}
                  </p>
                  {note("status")}
                  <Button
                    variant="secondary"
                    disabled={busy || readOnly}
                    onClick={() => setActive(!unit.active)}
                  >
                    {unit.active ? f.switchOff : f.switchOn}
                  </Button>
                </div>
              </Panel>
              {reporting && <UnitReporting {...reporting} />}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
