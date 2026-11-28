"use client";

import { MailWarning } from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { hasLocale, localeNames, type Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, codeOf } from "@/lib/api";
import { fill, languageNameIn } from "@/lib/format";
import { Words } from "@/components/policies/sentence";

/** A person's email preferences, as the API gives them. */
type Preferences = {
  immediate: boolean;
  digest: boolean;
  /** Null: the organization's default language. */
  language: string | null;
  /** Whether the organization sends email at all. */
  organizationEnabled: boolean;
  /** Whether others count on this person's emails: approval steps, triage. */
  reliedOn?: { approves: boolean; triages: boolean };
};

type Text = Dictionary["notifications"]["preferences"];

/** A language's own name, as a choice of language is offered. */
const ownName = (locale: string) =>
  hasLocale(locale) ? localeNames[locale] : locale;

/**
 * The signed-in person's email: whether they receive the immediate emails
 * and the morning summary, and in which language. What each sends is
 * listed, for the modules the organization has. Their own, open to
 * everyone and while the subscription is suspended.
 */
export function NotificationPreferences({
  lang,
  t,
}: {
  lang: Locale;
  t: Text;
}) {
  const session = useSession();
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    let current = true;
    api<Preferences>("/me/notification-preferences")
      .then((loaded) => {
        if (!current) return;
        setSaved(loaded);
        setProblem(false);
      })
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, []);

  const manages = session.scope?.["settings.manage"] === "all";

  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        {problem ? (
          <Panel>
            <EmptyState>{t.loadError}</EmptyState>
          </Panel>
        ) : !saved ? (
          <Panel>
            <EmptyState>{t.loading}</EmptyState>
          </Panel>
        ) : (
          <>
            {!saved.organizationEnabled && (
              <div
                role="note"
                className="flex items-start gap-2 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm"
              >
                <MailWarning
                  className="mt-0.5 size-4 shrink-0 text-warn"
                  aria-hidden
                />
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{t.organizationOff}</p>
                  <p>{manages ? t.organizationOffManager : t.organizationOffHelp}</p>
                  {manages && (
                    <p>
                      <Link
                        href={`/${lang}/admin/settings`}
                        className="font-medium text-accent hover:underline"
                      >
                        {t.openSettings}
                      </Link>
                    </p>
                  )}
                </div>
              </div>
            )}
            <PreferencesForm
              lang={lang}
              t={t}
              saved={saved}
              onSaved={setSaved}
            />
          </>
        )}
        <p className="text-sm">
          <Link
            href={`/${lang}/notifications`}
            className="text-accent hover:underline"
          >
            {t.back}
          </Link>
        </p>
      </div>
    </>
  );
}

function PreferencesForm({
  lang,
  t,
  saved,
  onSaved,
}: {
  lang: Locale;
  t: Text;
  saved: Preferences;
  onSaved: (preferences: Preferences) => void;
}) {
  const session = useSession();
  const { locales, defaultLocale } = session.tenant;
  const named = languageNameIn(lang);
  const [immediate, setImmediate] = useState(saved.immediate);
  const [digest, setDigest] = useState(saved.digest);
  const [language, setLanguage] = useState(saved.language ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // Visited pages stay mounted: "Saved." does not wait there.
  useLayoutEffect(() => () => setMessage(null), []);

  const incidents = hasModule(session, "incidents");
  const policies = hasModule(session, "policies");
  const changed =
    immediate !== saved.immediate ||
    digest !== saved.digest ||
    (language || null) !== saved.language;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const answer = await api<Preferences>("/me/notification-preferences", {
        method: "PATCH",
        body: { immediate, digest, language: language || null },
      });
      onSaved(answer);
      setImmediate(answer.immediate);
      setDigest(answer.digest);
      setLanguage(answer.language ?? "");
      setMessage({ ok: true, text: t.saved });
    } catch (err) {
      setMessage({
        ok: false,
        text:
          codeOf(err) === "language_mismatch" ? t.languageMismatch : t.saveError,
      });
    }
    setBusy(false);
  }

  const immediateItems = [
    ...(incidents
      ? [t.immediateItems.serious, t.immediateItems.sentinel, t.immediateItems.assigned, t.immediateItems.signOff]
      : []),
    ...(policies ? [t.immediateItems.step] : []),
  ];
  const digestItems = [
    ...(policies
      ? [t.digestItems.acknowledge, t.digestItems.approve, t.digestItems.reviews]
      : []),
    ...(incidents ? [t.digestItems.incidents] : []),
  ];

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <Panel title={t.emailTitle}>
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-muted">
            <Words
              text={t.sentTo}
              values={{
                email: (
                  <span dir="ltr" className="font-medium text-foreground [overflow-wrap:anywhere]">
                    {session.user.email}
                  </span>
                ),
              }}
            />
          </p>
          <Switch
            checked={immediate}
            onChange={setImmediate}
            label={t.immediate}
            state={immediate ? t.on : t.off}
          >
            <p>{t.immediateHelp}</p>
            <Items items={immediateItems} />
            {/* Before an approver or a triager goes without them. */}
            {!immediate && (saved.reliedOn?.approves || saved.reliedOn?.triages) && (
              <div
                role="note"
                className="mt-1 flex flex-col gap-1 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-foreground"
              >
                {/* Said of the morning summary only while it is on. */}
                {saved.reliedOn?.approves && (
                  <p>{digest ? t.reliedOnApproves : t.reliedOnApprovesNoDigest}</p>
                )}
                {saved.reliedOn?.triages && <p>{t.reliedOnTriages}</p>}
              </div>
            )}
          </Switch>
          <Switch
            checked={digest}
            onChange={setDigest}
            label={t.digest}
            state={digest ? t.on : t.off}
          >
            <p>{t.digestHelp}</p>
            <Items items={digestItems} />
            {policies && <p>{t.weekly}</p>}
          </Switch>
          <p className="text-xs text-muted">{t.noDetails}</p>
        </div>
      </Panel>

      <Panel title={t.languageTitle}>
        <div className="flex flex-col gap-3 p-4">
          {locales.length > 1 ? (
            <div className="max-w-xs">
              <Field label={t.language} help={t.languageHelp}>
                <select
                  name="language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className={inputClass}
                >
                  <option value="">
                    {fill(t.languageDefault, { language: named(defaultLocale) })}
                  </option>
                  {locales.map((l) => (
                    <option key={l} value={l} lang={l}>
                      {ownName(l)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : (
            <p className="text-sm text-muted">
              {fill(t.languageOnly, { language: named(defaultLocale) })}
            </p>
          )}
        </div>
      </Panel>

      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}
        >
          {message.text}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy || !changed}>
          {busy ? t.saving : t.save}
        </Button>
      </div>
    </form>
  );
}

/** A switch with what it covers under it; the label is the control's name. */
function Switch({
  checked,
  onChange,
  label,
  state,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  /** "On" or "Off", said beside it. */
  state: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <span className="flex shrink-0 items-center gap-2 text-sm text-muted">
          <span aria-hidden>{state}</span>
          <input
            type="checkbox"
            role="switch"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative inline-flex h-6 w-11 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:start-0.5 after:size-5 after:rounded-full after:bg-background after:shadow after:transition-transform peer-checked:after:translate-x-5 rtl:peer-checked:after:-translate-x-5"
          />
        </span>
      </label>
      <div className="flex flex-col gap-1 text-sm text-muted">{children}</div>
    </div>
  );
}

function Items({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-0.5 ps-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
