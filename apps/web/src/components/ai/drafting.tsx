"use client";

import { FilePenLine, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { can, useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Markup } from "@/components/policies/markup";
import {
  DocumentFields,
  loadLists,
  readDocumentBody,
  type Lists,
} from "@/components/policies/document-form";
import { textareaClass, type PoliciesProps, type PoliciesText } from "@/components/policies/types";
import { api, codeOf, detailsOf, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, languageNameIn } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { documentPath } from "@/lib/policies";
import {
  assumptionMark,
  gapMark,
  type AiSettings,
  type Draft,
  type DraftSummary,
  type DraftVersion,
} from "@/lib/ai";
import { AiMark, AiPanel } from "./ai-mark";

/**
 * Whether drafting with the assistant is offered to this person now: the
 * AI and policies modules, documents they manage, and drafting active in
 * the organization's AI settings. Null while that is being read.
 */
export function useDraftingActive(): boolean | null {
  const session = useSession();
  const possible =
    hasModule(session, "ai_assistant") &&
    hasModule(session, "policies") &&
    can(session, "policies.manage");
  const [active, setActive] = useState<boolean | null>(null);
  useEffect(() => {
    if (!possible) return;
    let current = true;
    api<AiSettings>("/ai/settings").then(
      (s) => {
        if (current) setActive(s.features.some((f) => f.feature === "drafting" && f.active));
      },
      () => {
        if (current) setActive(false);
      },
    );
    return () => {
      current = false;
    };
  }, [possible]);
  return possible ? active : false;
}

/** An AI refusal, or another refusal of drafting, in words. */
export function useDraftingRefusal(lang: string, t: PoliciesText) {
  const day = dayFormat(lang);
  const e = t.errors as Record<string, string>;
  return (err: unknown): string => {
    const code = codeOf(err);
    const details = detailsOf(err);
    if (code === "ai_allowance_reached") {
      return fill(t.drafting.allowanceReached, { date: day(String(details.resetsOn ?? "")) ?? "" });
    }
    if (code === "draft_too_long_for_assistant") return t.drafting.tooLongForAssistant;
    if (code && Object.hasOwn(e, code)) return e[code];
    const status = statusOf(err);
    if (status === 403) return e.missing_permission;
    if (status === 404) return t.notFound;
    return status === 400 ? e.invalid : e.generic;
  };
}

/**
 * On "New policy or procedure": write it by hand, or draft it with the
 * assistant, with the drafts this person has under way.
 */
export function DraftChoice({ lang, t }: PoliciesProps) {
  const d = t.drafting;
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  useEffect(() => {
    let current = true;
    api<{ items: DraftSummary[] }>("/ai/drafts").then(
      (r) => {
        if (current) setDrafts(r.items.filter((x) => x.status !== "handed_over"));
      },
      () => {
        if (current) setDrafts([]);
      },
    );
    return () => {
      current = false;
    };
  }, []);
  const moment = dateTimeFormat(lang, useSession().tenant.timeZone);
  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <a
          href="#write"
          className="flex flex-col gap-1 rounded-lg border border-line p-4 hover:bg-surface"
        >
          <span className="flex items-center gap-2 font-medium">
            <FilePenLine className="size-4 text-muted" aria-hidden />
            {d.writeYourself}
          </span>
          <span className="text-sm text-muted">{d.writeYourselfHelp}</span>
        </a>
        <Link
          href={`/${lang}/policies/drafts/new`}
          className="flex flex-col gap-1 rounded-lg border border-line border-s-4 border-s-ai p-4 hover:bg-ai-soft"
        >
          <span className="flex items-center gap-2 font-medium">
            <Sparkles className="size-4 text-ai" aria-hidden />
            {d.withAssistant}
          </span>
          <span className="text-sm text-muted">{d.withAssistantHelp}</span>
        </Link>
      </div>
      {drafts && drafts.length > 0 && (
        <Panel title={d.underWay}>
          <ul>
            {drafts.map((x) => (
              <li key={x.id} className="border-b border-line px-4 py-3 text-sm last:border-b-0">
                <Link href={`/${lang}/policies/drafts/${x.id}`} className="font-medium text-accent hover:underline">
                  <bdi dir="auto">{x.request.length > 120 ? `${x.request.slice(0, 120)}…` : x.request}</bdi>
                </Link>
                <p className="text-xs text-muted">
                  {(d.status as Record<string, string>)[x.status] ?? x.status}
                  {" · "}
                  {fill(d.lastActivity, { time: moment.format(new Date(x.lastActivityAt)) })}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/** Starting a draft: its type, its language and what it is for. */
export function NewDraft({ lang, t }: PoliciesProps) {
  const session = useSession();
  const router = useRouter();
  const d = t.drafting;
  const active = useDraftingActive();
  const explain = useDraftingRefusal(lang, t);
  const [lists, setLists] = useState<Lists | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);
  const languageName = languageNameIn(lang);
  const inLang = (text: Localized | null | undefined) => pick(text, lang, session.tenant.defaultLocale);

  useEffect(() => {
    if (!active) return;
    let current = true;
    loadLists().then(
      (l) => {
        if (current) setLists(l);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [active]);

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const draft = await api<Draft>("/ai/drafts", {
        method: "POST",
        body: {
          documentTypeId: String(data.get("documentTypeId")),
          request: String(data.get("request") ?? "").trim(),
          locale: String(data.get("locale")),
        },
      });
      form.reset();
      router.push(`/${lang}/policies/drafts/${draft.id}`);
      return;
    } catch (err) {
      // The conversation exists even when the assistant could not answer.
      const draftId = detailsOf(err).draftId;
      if (typeof draftId === "string") {
        form.reset();
        router.push(`/${lang}/policies/drafts/${draftId}`);
        return;
      }
      setError(explain(err));
    }
    setBusy(false);
  }

  return (
    <>
      <PageHeader title={d.newTitle} description={d.newDescription} />
      <div className="mt-6 max-w-2xl">
        {active === null ? (
          <EmptyState>{t.loading}</EmptyState>
        ) : !active ? (
          <EmptyState>{d.notActive}</EmptyState>
        ) : !lists ? (
          <EmptyState>{t.loading}</EmptyState>
        ) : (
          <AiPanel mark={d.aiDraft} notice={d.notice}>
            <form onSubmit={start} className="flex flex-col gap-5">
              <Field label={d.type}>
                <select name="documentTypeId" required defaultValue="" className={inputClass}>
                  <option value="" disabled>
                    {t.form.choose}
                  </option>
                  {lists.types.map((x) => (
                    <option key={x.id} value={x.id}>
                      {inLang(x.name)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={d.languageLabel}>
                <select name="locale" defaultValue={session.tenant.locales.includes(lang) ? lang : session.tenant.defaultLocale} className={inputClass}>
                  {session.tenant.locales.map((l) => (
                    <option key={l} value={l}>
                      {languageName(l)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={d.requestLabel} help={d.requestHelp}>
                <textarea name="request" required maxLength={4000} rows={5} dir="auto" className={textareaClass} />
              </Field>
              <p className="text-sm text-muted">{d.keptFor}</p>
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              <div>
                <Button type="submit" disabled={busy}>
                  {busy ? d.thinking : d.start}
                </Button>
              </div>
            </form>
          </AiPanel>
        )}
      </div>
    </>
  );
}

/** A draft's text with its gaps and assumptions drawn apart, still as text. */
function marked(t: PoliciesText) {
  return (text: string): ReactNode => {
    const pattern = new RegExp(`${gapMark.source}|${assumptionMark.source}`, "g");
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      if (at > last) out.push(text.slice(last, at));
      const gap = new RegExp(gapMark.source).test(m[0]);
      out.push(
        <mark
          key={at}
          className={`rounded px-0.5 ${gap ? "bg-warn-soft text-warn" : "bg-surface text-muted"}`}
          title={gap ? t.drafting.gap : t.drafting.assumption}
        >
          {m[0]}
        </mark>,
      );
      last = at + m[0].length;
    }
    if (out.length === 0) return text;
    if (last < text.length) out.push(text.slice(last));
    return <>{out.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;
  };
}

/** One version of the draft: its title, sections, marks and sources. */
export function DraftVersionView({
  lang,
  t,
  version,
  sectionNames,
  locale,
}: PoliciesProps & {
  version: DraftVersion;
  sectionNames: Record<string, Localized>;
  locale: string;
}) {
  const session = useSession();
  const d = t.drafting;
  const inLang = (text: Localized | null | undefined) => pick(text, lang, session.tenant.defaultLocale);
  const content = version.content[locale] ?? Object.values(version.content)[0] ?? {};
  const highlight = marked(t);
  const nameOf = (key: string) => inLang(sectionNames[key]) || key;
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold" dir="auto">
        {pick(version.title, locale, session.tenant.defaultLocale)}
      </h3>
      {Object.entries(content).map(([key, text]) =>
        text ? (
          <section key={key} className="flex flex-col gap-1">
            <h4 className="text-sm font-semibold">{nameOf(key)}</h4>
            <div dir="auto">
              <Markup text={text} highlight={highlight} />
            </div>
          </section>
        ) : null,
      )}
      {version.gaps.length > 0 && (
        <div className="rounded-md border border-warn bg-warn-soft p-3 text-sm">
          <p className="font-medium">{d.gaps}</p>
          <p className="text-xs">{d.gapsHelp}</p>
          <ul className="mt-1 list-disc ps-5">
            {version.gaps.map((g, i) => (
              <li key={i}>
                <span className="font-medium">{nameOf(g.section)}</span>
                {": "}
                <bdi dir="auto">{g.text}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
      {version.assumptions.length > 0 && (
        <div className="rounded-md border border-line bg-surface p-3 text-sm">
          <p className="font-medium">{d.assumptions}</p>
          <p className="text-xs text-muted">{d.assumptionsHelp}</p>
          <ul className="mt-1 list-disc ps-5">
            {version.assumptions.map((g, i) => (
              <li key={i}>
                <span className="font-medium">{nameOf(g.section)}</span>
                {": "}
                <bdi dir="auto">{g.text}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
      {version.sources.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">{d.sources}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {version.sources.map((s) => (
              <li key={s.documentId}>
                <Link href={documentPath(lang, s.documentId)} className="text-accent hover:underline">
                  <bdi dir="ltr" className="whitespace-nowrap">
                    {s.number}
                  </bdi>{" "}
                  <bdi>{inLang(s.title)}</bdi>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The questions and answers so far, and the changes asked for. */
export function DraftTurns({ lang, t, draft }: PoliciesProps & { draft: Draft }) {
  const d = t.drafting;
  const asked = new Map<string, { text: string; reason: string }>();
  for (const turn of draft.turns) {
    if (turn.kind === "questions") {
      for (const q of (turn.body as { questions: { id: string; text: string; reason: string }[] }).questions)
        asked.set(q.id, q);
    }
  }
  const answered = draft.turns.filter((x) => x.kind === "answers" || x.kind === "revision_request");
  if (answered.length === 0) return null;
  const languageName = languageNameIn(lang);
  return (
    <ol className="flex flex-col gap-3 text-sm">
      {answered.map((turn) =>
        turn.kind === "answers" ? (
          <li key={turn.seq} className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted">
              {fill(d.round, { round: String((turn.body as { round: number }).round) })}
            </p>
            {(turn.body as { answers: { questionId: string; answer: string | null }[] }).answers.map((a) => (
              <div key={a.questionId} className="flex flex-col gap-0.5 border-s-2 border-line ps-3">
                <p dir="auto" className="text-muted">
                  {asked.get(a.questionId)?.text}
                </p>
                <p dir="auto">{a.answer ?? <em className="text-muted">{d.notDecided}</em>}</p>
              </div>
            ))}
          </li>
        ) : (
          <li key={turn.seq} className="border-s-2 border-line ps-3">
            <p className="text-xs font-medium text-muted">
              {fill(d.changeAsked, {
                language: languageName(String((turn.body as { locale?: string }).locale ?? draft.locale)),
              })}
            </p>
            <p dir="auto">{String((turn.body as { instruction?: string }).instruction ?? "")}</p>
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * A conversation with the assistant: the request, rounds of questions with
 * their reasons ("not decided" is an answer), then versions of the draft,
 * changes asked for or made by hand, and handing a version over as a
 * document. The assistant's text is marked as an AI draft throughout.
 */
export function DraftConversation({ lang, t }: PoliciesProps) {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const router = useRouter();
  const d = t.drafting;
  const explain = useDraftingRefusal(lang, t);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  const [locale, setLocale] = useState<string | null>(null);
  const [mode, setMode] = useState<"read" | "revise" | "edit" | "handOver">("read");
  const [whole, setWhole] = useState(true);
  const [ack, setAck] = useState(false);
  useLayoutEffect(
    () => () => {
      setError(null);
      setMode("read");
    },
    [],
  );
  const languageName = languageNameIn(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const inLang = (text: Localized | null | undefined) => pick(text, lang, session.tenant.defaultLocale);

  useEffect(() => {
    let current = true;
    Promise.all([api<Draft>(`/ai/drafts/${id}`), loadLists()]).then(
      ([loaded, l]) => {
        if (!current) return;
        setDraft(loaded);
        setLists(l);
        setProblem(null);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 404 ? d.notFound : t.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [id, d, t]);

  /** Sends a step; the conversation as it then is, or the refusal said. */
  async function step(name: string, path: string, body?: unknown, after?: () => void) {
    setBusy(name);
    setError(null);
    try {
      const next = await api<Draft>(`/ai/drafts/${id}${path}`, { method: "POST", body });
      setDraft(next);
      setShownVersion(null);
      after?.();
    } catch (err) {
      setError(explain(err));
      // Changed meanwhile, or the assistant failed part way: as it is now.
      api<Draft>(`/ai/drafts/${id}`).then(setDraft, () => {});
    }
    setBusy(null);
  }

  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (!draft || !lists || draft.id !== id) return <EmptyState>{t.loading}</EmptyState>;

  const type = lists.types.find((x) => x.id === draft.documentTypeId);
  const sectionNames = Object.fromEntries((type?.sections ?? []).map((s) => [s.key, s.name]));
  const latest = draft.versions.at(-1) ?? null;
  const version = draft.versions.find((v) => v.number === shownVersion) ?? latest;
  const shownLocale =
    locale && version?.content[locale] ? locale : version ? (version.content[draft.locale] ? draft.locale : Object.keys(version.content)[0]) : draft.locale;
  const handedOver = draft.status === "handed_over";
  const statuses = d.status as Record<string, string>;

  function answer(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const answers = draft!.openQuestions.map((q) => {
      const undecided = data.get(`undecided.${q.id}`) === "on";
      const text = String(data.get(`answer.${q.id}`) ?? "").trim();
      return { questionId: q.id, answer: undecided || !text ? null : text };
    });
    const form = e.currentTarget;
    void step("answers", "/answers", { answers, revision: draft!.revision }, () => form.reset());
  }

  function revise(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    void step(
      "revise",
      "/revisions",
      {
        instruction: String(data.get("instruction") ?? "").trim(),
        locale: String(data.get("locale")),
        revision: draft!.revision,
      },
      () => {
        form.reset();
        setMode("read");
      },
    );
  }

  function edit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const sections: Record<string, string | null> = {};
    for (const s of type?.sections ?? []) {
      const v = String(data.get(`section.${s.key}`) ?? "");
      sections[s.key] = v.trim() ? v : null;
    }
    void step("edit", "/edits", { content: { [shownLocale]: sections }, revision: draft!.revision }, () => setMode("read"));
  }

  async function handOver(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = readDocumentBody(form, whole);
    if (!body) return setError(t.form.audienceUnitsMissing);
    const data = new FormData(form);
    setBusy("handOver");
    setError(null);
    try {
      const doc = await api<{ id: string }>(`/ai/drafts/${id}/hand-over`, {
        method: "POST",
        body: {
          ...body,
          acknowledgementRequired: ack,
          ...(ack ? { acknowledgeWithinDays: Number(data.get("acknowledgeWithinDays") ?? 14) } : {}),
          version: version?.number,
          revision: draft!.revision,
        },
      });
      form.reset();
      router.push(documentPath(lang, doc.id));
      return;
    } catch (err) {
      setError(explain(err));
    }
    setBusy(null);
  }

  async function discard() {
    setBusy("discard");
    setError(null);
    try {
      await api(`/ai/drafts/${id}/discard`, { method: "POST" });
      router.push(`/${lang}/policies/new`);
      return;
    } catch (err) {
      setError(explain(err));
    }
    setBusy(null);
  }

  const said = error && (
    <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm">
      {error}
    </p>
  );

  return (
    <>
      <PageHeader
        title={d.conversationTitle}
        description={
          <>
            <bdi>{inLang(type?.name)}</bdi>
            {" · "}
            {languageName(draft.locale)}
            {" · "}
            {statuses[draft.status] ?? draft.status}
          </>
        }
        actions={<AiMark>{d.aiDraft}</AiMark>}
      />
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <Link href={`/${lang}/policies/new`} className="text-accent hover:underline">
          {d.back}
        </Link>
        {handedOver && draft.documentId && (
          <Link href={documentPath(lang, draft.documentId)} className="text-accent hover:underline">
            {d.openDocument}
          </Link>
        )}
      </div>
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* The conversation. */}
        <div className="flex flex-col gap-4">
          <Panel title={d.requestTitle}>
            <div className="flex flex-col gap-3 p-4 text-sm">
              <p dir="auto" className="whitespace-pre-wrap">
                {draft.request}
              </p>
              <DraftTurns lang={lang} t={t} draft={draft} />
              <p className="text-xs text-muted">
                {fill(d.rounds, { rounds: String(draft.rounds), max: String(draft.maxRounds) })}
                {" · "}
                {fill(d.lastActivity, { time: moment.format(new Date(draft.lastActivityAt)) })}
              </p>
              <p className="text-xs text-muted">{d.keptFor}</p>
            </div>
          </Panel>
          {said}
          {!handedOver && draft.openQuestions.length > 0 && (
            <AiPanel mark={d.aiQuestions} notice={d.notice}>
              <form onSubmit={answer} className="flex flex-col gap-4">
                <p className="text-sm font-medium">{d.questionsTitle}</p>
                {draft.openQuestions.map((q) => (
                  <div key={q.id} className="flex flex-col gap-1.5">
                    <Field label={q.text} help={fill(d.reason, { reason: q.reason })}>
                      <textarea name={`answer.${q.id}`} rows={2} maxLength={2000} dir="auto" className={textareaClass} />
                    </Field>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name={`undecided.${q.id}`} className="size-4" />
                      {d.notDecided}
                    </label>
                  </div>
                ))}
                <p className="text-xs text-muted">{d.emptyIsUndecided}</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy !== null}>
                    {busy === "answers" ? d.thinking : d.submitAnswers}
                  </Button>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void step("draft", "/draft")}>
                    {busy === "draft" ? d.thinking : d.draftNow}
                  </Button>
                </div>
              </form>
            </AiPanel>
          )}
          {!handedOver && draft.status === "asking" && draft.openQuestions.length === 0 && (
            <Panel>
              <div className="flex flex-col gap-3 p-4 text-sm">
                <p>{d.noQuestionsYet}</p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy !== null} onClick={() => void step("ask", "/questions")}>
                    {busy === "ask" ? d.thinking : d.askAgain}
                  </Button>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void step("draft", "/draft")}>
                    {busy === "draft" ? d.thinking : d.draftNow}
                  </Button>
                </div>
              </div>
            </Panel>
          )}
          {!handedOver && draft.status === "ready" && draft.versions.length === 0 && (
            <Panel>
              <div className="flex flex-col gap-3 p-4 text-sm">
                <p>{d.readyToDraft}</p>
                <div>
                  <Button disabled={busy !== null} onClick={() => void step("draft", "/draft")}>
                    {busy === "draft" ? d.thinking : d.draftNow}
                  </Button>
                </div>
              </div>
            </Panel>
          )}
          {!handedOver && (
            <div>
              <Button variant="secondary" disabled={busy !== null} onClick={() => void discard()}>
                {d.discard}
              </Button>
              <p className="mt-1 text-xs text-muted">{d.discardHelp}</p>
            </div>
          )}
        </div>

        {/* The draft. */}
        <div className="flex flex-col gap-4">
          {!version ? (
            <Panel>
              <EmptyState>{d.noVersionYet}</EmptyState>
            </Panel>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-4">
                <Field label={d.versions}>
                  <select
                    value={version.number}
                    onChange={(e) => setShownVersion(Number(e.target.value))}
                    className={inputClass}
                  >
                    {[...draft.versions].reverse().map((v) => (
                      <option key={v.number} value={v.number}>
                        {fill(v.author === "assistant" ? d.versionByAssistant : d.versionByPerson, {
                          number: String(v.number),
                          time: moment.format(new Date(v.createdAt)),
                        })}
                      </option>
                    ))}
                  </select>
                </Field>
                {Object.keys(version.content).length > 1 && (
                  <Field label={d.languageLabel}>
                    <select value={shownLocale} onChange={(e) => setLocale(e.target.value)} className={inputClass}>
                      {Object.keys(version.content).map((l) => (
                        <option key={l} value={l}>
                          {languageName(l)}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
              {version.author === "assistant" ? (
                <AiPanel mark={d.aiDraft} notice={d.notice}>
                  <DraftVersionView lang={lang} t={t} version={version} sectionNames={sectionNames} locale={shownLocale} />
                  {version.model && <p className="text-xs text-muted">{fill(d.model, { model: version.model })}</p>}
                </AiPanel>
              ) : (
                <Panel>
                  <div className="flex flex-col gap-3 p-4">
                    <Pill tone="neutral">{d.editedByPerson}</Pill>
                    <DraftVersionView lang={lang} t={t} version={version} sectionNames={sectionNames} locale={shownLocale} />
                  </div>
                </Panel>
              )}

              {!handedOver && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setMode(mode === "revise" ? "read" : "revise")} aria-expanded={mode === "revise"}>
                    {d.revise}
                  </Button>
                  <Button variant="secondary" onClick={() => setMode(mode === "edit" ? "read" : "edit")} aria-expanded={mode === "edit"}>
                    {d.editByHand}
                  </Button>
                  <Button onClick={() => setMode(mode === "handOver" ? "read" : "handOver")} aria-expanded={mode === "handOver"}>
                    {fill(d.handOverVersion, { number: String(version.number) })}
                  </Button>
                </div>
              )}

              {mode === "revise" && !handedOver && (
                <Panel title={d.revise}>
                  <form onSubmit={revise} className="flex flex-col gap-4 p-4">
                    <Field label={d.reviseLabel} help={d.reviseHelp}>
                      <textarea name="instruction" required maxLength={2000} rows={3} dir="auto" className={textareaClass} />
                    </Field>
                    <Field label={d.translateTo} help={d.translateHelp}>
                      <select name="locale" defaultValue={shownLocale} className={inputClass}>
                        {session.tenant.locales.map((l) => (
                          <option key={l} value={l}>
                            {languageName(l)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div>
                      <Button type="submit" disabled={busy !== null}>
                        {busy === "revise" ? d.thinking : d.sendRevision}
                      </Button>
                    </div>
                  </form>
                </Panel>
              )}

              {mode === "edit" && !handedOver && (
                <Panel title={d.editByHand}>
                  <form key={`${version.number}:${shownLocale}`} onSubmit={edit} className="flex flex-col gap-4 p-4">
                    <p className="text-sm text-muted">{fill(d.editHelp, { language: languageName(shownLocale) })}</p>
                    {(type?.sections ?? []).map((s) => (
                      <Field key={s.key} label={inLang(s.name)}>
                        <textarea
                          name={`section.${s.key}`}
                          rows={6}
                          dir="auto"
                          defaultValue={version.content[shownLocale]?.[s.key] ?? ""}
                          className={textareaClass}
                        />
                      </Field>
                    ))}
                    <div>
                      <Button type="submit" disabled={busy !== null}>
                        {d.saveEdit}
                      </Button>
                    </div>
                  </form>
                </Panel>
              )}

              {mode === "handOver" && !handedOver && (
                <form onSubmit={handOver} className="flex flex-col gap-6">
                  <p className="text-sm text-muted">{d.handOverHelp}</p>
                  <DocumentFields
                    lang={lang}
                    t={t}
                    lists={lists}
                    doc={null}
                    typeId={draft.documentTypeId}
                    onTypeChange={() => {}}
                    typeFixed
                    whole={whole}
                    onWholeChange={setWhole}
                    acknowledgement={{ required: ack, onChange: setAck }}
                    titleDefault={version.title}
                  />
                  {said}
                  <div>
                    <Button type="submit" disabled={busy !== null}>
                      {d.handOver}
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** For the new document page: the choice, when the assistant is offered. */
export function DraftingOffer({ lang, t }: PoliciesProps) {
  const active = useDraftingActive();
  if (!active) return null;
  return <DraftChoice lang={lang} t={t} />;
}

/** The conversation behind an AI-drafted document, read from its history. */
export function DraftHistory({ lang, t }: PoliciesProps) {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const d = t.drafting;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  useEffect(() => {
    let current = true;
    Promise.all([api<Draft>(`/policies/documents/${id}/ai-draft`), loadLists()]).then(
      ([loaded, l]) => {
        if (!current) return;
        setDraft(loaded);
        setLists(l);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 404 ? d.historyNotFound : t.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [id, d, t]);
  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (!draft || !lists) return <EmptyState>{t.loading}</EmptyState>;
  const type = lists.types.find((x) => x.id === draft.documentTypeId);
  const sectionNames = Object.fromEntries((type?.sections ?? []).map((s) => [s.key, s.name]));
  return (
    <>
      <PageHeader title={d.historyTitle} description={d.historyDescription} actions={<AiMark>{d.aiDraft}</AiMark>} />
      <div className="mt-4">
        <Link href={documentPath(lang, id)} className="text-sm text-accent hover:underline">
          {d.backToDocument}
        </Link>
      </div>
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        <Panel title={d.requestTitle}>
          <div className="flex flex-col gap-3 p-4 text-sm">
            <p dir="auto" className="whitespace-pre-wrap">
              {draft.request}
            </p>
            <DraftTurns lang={lang} t={t} draft={draft} />
          </div>
        </Panel>
        {draft.versions.map((v) => (
          <div key={v.number} className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              {fill(v.author === "assistant" ? d.versionByAssistant : d.versionByPerson, {
                number: String(v.number),
                time: moment.format(new Date(v.createdAt)),
              })}
              {draft.handedOverVersion === v.number && (
                <span className="ms-2">
                  <Pill tone="ok">{d.handedOverMark}</Pill>
                </span>
              )}
            </p>
            {v.author === "assistant" ? (
              <AiPanel mark={d.aiDraft} notice={d.notice}>
                <DraftVersionView lang={lang} t={t} version={v} sectionNames={sectionNames} locale={draft.locale} />
                {v.model && <p className="text-xs text-muted">{fill(d.model, { model: v.model })}</p>}
              </AiPanel>
            ) : (
              <Panel>
                <div className="p-4">
                  <DraftVersionView lang={lang} t={t} version={v} sectionNames={sectionNames} locale={draft.locale} />
                </div>
              </Panel>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
