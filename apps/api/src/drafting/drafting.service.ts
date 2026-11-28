import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { aiRefusalException, AiService, type AiRefusal } from '../ai/ai.service.js';
import { asData } from '../ai/prompt.js';
import { ApprovalEngine } from '../approvals/approval-engine.service.js';
import type { Transaction } from '../database/client.js';
import {
  documents,
  documentTypes,
  documentVersions,
  draftingMessages,
  draftingSessions,
  draftingVersions,
  orgUnits,
  tenants,
  users,
  type DocumentContent,
  type DocumentSection,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { pickText, type Localized } from '../i18n/locales.js';
import { markupProblem, normalizeSection, SECTION_MAX_CHARS } from '../policies/content.js';
import { DocumentsService } from '../policies/documents.service.js';
import type { CreateInput } from '../policies/input.js';
import { checkedSection } from '../policies/section-input.js';
import { fullSight, readsPublished, viewerOf } from '../policies/visibility.js';
import { DesignService, type EffectiveDesign } from './design.service.js';
import { ProfileService } from './profile.service.js';
import {
  conversationText,
  DRAFT_TASK,
  draftAnswer,
  draftText,
  gapMark,
  marksOf,
  MAX_DRAFT_FOR_REVISION,
  MAX_ROUNDS,
  MAX_SOURCES,
  QUESTIONS_TASK,
  questionsAnswer,
  REVISION_TASK,
  showMarks,
  sourcesText,
  systemText,
  type DraftAnswer,
  type DraftingContext,
  type QA,
  type Source,
} from './prompts.js';

type Session = typeof draftingSessions.$inferSelect;
type Question = { id: string; text: string; reason: string };
type Answer = { questionId: string; answer: string | null };
type SourceRef = { documentId: string; number: string; title: Localized };

/** The longest answers the assistant may give, in tokens. */
const QUESTIONS_TOKENS = 2_000;
const DRAFT_TOKENS = 12_000;
const DRAFT_TIMEOUT_MS = 150_000;

/** A refusal of the assistant, as HTTP, saying which draft it was about. */
function refused(refusal: AiRefusal, draftId: string) {
  const error = aiRefusalException(refusal);
  const body = error.getResponse() as Record<string, unknown>;
  return new (error.constructor as new (b: unknown) => Error)({ ...body, draftId });
}

/**
 * Drafting a policy or procedure with the assistant
 * (docs/specs/ai-policy-drafting.md, "How it works for the user"). One
 * conversation per draft, the person's own: the request, questions a few at
 * a time with their reasons, the answers ("not decided" is one), then the
 * draft section by section in the client's design, with assumptions and
 * gaps marked and the existing documents it drew on listed, then
 * revisions, each a new version. Handed over, it becomes an ordinary draft
 * document of the policies module, marked as an AI draft until a person
 * takes ownership of it.
 *
 * The assistant never approves, publishes or changes a controlled
 * document: nothing here does. Every call goes through
 * `AiService.run(…, 'drafting', …)`, so allowances, spending limits, name
 * removal and the client's switch hold; each conversation is one draft of
 * the allowance (its id is the request's `unit`).
 *
 * Work is done in short transactions around each call to the assistant,
 * which takes seconds: the conversation's `revision` says whether it
 * changed meanwhile (409 `draft_changed`).
 */
@Injectable()
export class DraftingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly ai: AiService,
    private readonly provisioning: ProvisioningService,
    private readonly profiles: ProfileService,
    private readonly designs: DesignService,
    private readonly documents: DocumentsService,
    private readonly engine: ApprovalEngine,
  ) {}

  // -------------------------------------------------------------------------
  // Reading.
  // -------------------------------------------------------------------------

  /** The caller's own conversations not handed over or discarded, newest first. */
  list(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: draftingSessions.id,
          status: draftingSessions.status,
          documentTypeId: draftingSessions.documentTypeId,
          locale: draftingSessions.locale,
          request: draftingSessions.request,
          lastActivityAt: draftingSessions.lastActivityAt,
          createdAt: draftingSessions.createdAt,
          versions: sql<number>`(select count(*)::int from ${draftingVersions} v where v.session_id = ${draftingSessions.id})`,
        })
        .from(draftingSessions)
        .where(
          and(
            eq(draftingSessions.createdBy, auth.user.id),
            inArray(draftingSessions.status, ['asking', 'ready', 'drafted']),
          ),
        )
        .orderBy(desc(draftingSessions.lastActivityAt));
      return { items: rows };
    });
  }

  /** One of the caller's conversations, whole. 404 for anyone else's. */
  get(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => this.view(tx, await this.mine(tx, auth, id)));
  }

  /**
   * The conversation behind an AI-drafted document, for those who see the
   * document in full: kept with its history (the spec's safeguard "the
   * questions and answers behind the draft are kept"). 404 otherwise.
   */
  behindDocument(auth: AuthContext, documentId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const [doc] = await tx
        .select({ sessionId: documents.aiDraftSessionId })
        .from(documents)
        .where(and(eq(documents.id, documentId), fullSight(viewer), isNotNull(documents.aiDraftSessionId)));
      if (!doc) throw new NotFoundException();
      const [session] = await tx.select().from(draftingSessions).where(eq(draftingSessions.id, doc.sessionId!));
      if (!session) throw new NotFoundException();
      return this.view(tx, session);
    });
  }

  // -------------------------------------------------------------------------
  // The conversation.
  // -------------------------------------------------------------------------

  /**
   * Opens a conversation for a type of document, with what the person needs
   * in their own words, in one of the client's languages (the person's own
   * language when the client works in it, else the client's main one), and
   * asks the first questions. 400 `unknown_type`, `language_mismatch`.
   *
   * Should the assistant refuse or be unavailable, the conversation stays,
   * and the refusal says which (`draftId`): questions can be asked again
   * (`POST …/questions`), or the draft written with what is known.
   */
  async start(auth: AuthContext, input: { documentTypeId: string; request: string; locale?: string }) {
    const { tenant, user } = auth;
    const session = await this.tenantDb.withTenant(tenant.id, async (tx) => {
      const locale = input.locale ?? (await this.localeOf(tx, auth));
      if (!tenant.locales.includes(locale)) throw new BadRequestException({ code: 'language_mismatch' });
      const type = await this.designs.typeOf(tx, input.documentTypeId).catch(() => {
        throw new BadRequestException({ code: 'unknown_type' });
      });
      const design = await this.designs.effective(tx, tenant.id, type.id);
      const [created] = await tx
        .insert(draftingSessions)
        .values({
          tenantId: tenant.id,
          createdBy: user.id,
          documentTypeId: type.id,
          locale,
          request: input.request,
          designId: design.id,
        })
        .returning();
      await this.provisioning.audit(tx, tenant.id, user.id, 'ai_draft_started', 'ai_draft', created.id, {
        typeId: type.id,
        locale,
      });
      return created;
    });
    return this.askRound(auth, session.id);
  }

  /**
   * Asks the next questions, when the last ones are answered (or none were
   * asked yet). After MAX_ROUNDS rounds, or when the assistant says it knows
   * enough, the conversation is ready to be drafted. 409 `not_asking`,
   * `questions_open`.
   */
  async askRound(auth: AuthContext, id: string) {
    const prepared = await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const session = await this.mine(tx, auth, id, true);
      if (session.status !== 'asking') throw new ConflictException({ code: 'not_asking' });
      const { open } = await this.questionsOf(tx, session.id);
      if (open.length > 0) throw new ConflictException({ code: 'questions_open' });
      const ctx = await this.contextOf(tx, auth, session);
      const qa = await this.qaOf(tx, session.id);
      return { session, ctx, qa };
    });
    const { session, ctx, qa } = prepared;
    const result = await this.ai.run(this.caller(auth), 'drafting', {
      system: systemText(ctx, QUESTIONS_TASK),
      messages: [{ role: 'user', content: conversationText(session.request, qa) }],
      maxTokens: QUESTIONS_TOKENS,
      tier: 'quick',
      output: questionsAnswer,
      people: [],
      unit: session.id,
    });
    if (!result.ok) throw refused(result, session.id);
    const answer = result.data!;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const current = await this.unchanged(tx, auth, session);
      const round = current.rounds + 1;
      const questions: Question[] = answer.questions.map((q, i) => ({ id: `q${round}-${i + 1}`, text: q.text, reason: q.reason }));
      const ready = questions.length === 0 || round >= MAX_ROUNDS;
      if (questions.length > 0) {
        await this.addTurn(tx, current, 'questions', { round, questions }, { aiRequestId: result.requestId });
      }
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'ai_draft_questions_asked', 'ai_draft', current.id, {
        round,
        questions: questions.length,
        aiRequestId: result.requestId,
      });
      // With no question left to ask after this round, the next step is the draft.
      await this.touch(tx, current, { rounds: round, status: ready && questions.length === 0 ? 'ready' : 'asking' });
      return this.view(tx, await this.mine(tx, auth, current.id));
    });
  }

  /**
   * Answers the open questions, every one of them: a text, or null for "not
   * decided", which the draft will carry as a gap. Then asks the next round,
   * unless that was the last. 400 `answers_mismatch`; 409 `not_asking`.
   */
  async answer(auth: AuthContext, id: string, input: { answers: Answer[]; revision: number }) {
    const next = await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const session = await this.mine(tx, auth, id, true);
      if (session.revision !== input.revision) throw new ConflictException({ code: 'draft_changed' });
      if (session.status !== 'asking') throw new ConflictException({ code: 'not_asking' });
      const { open, round } = await this.questionsOf(tx, session.id);
      const asked = new Set(open.map((q) => q.id));
      const given = new Set(input.answers.map((a) => a.questionId));
      if (open.length === 0 || asked.size !== given.size || [...asked].some((q) => !given.has(q))) {
        throw new BadRequestException({ code: 'answers_mismatch', questions: [...asked] });
      }
      await this.recordAnswers(tx, auth, session, round, input.answers);
      const last = session.rounds >= MAX_ROUNDS;
      if (last) await this.touch(tx, session, { status: 'ready' });
      return !last;
    });
    if (next) return this.askRound(auth, id);
    return this.get(auth, id);
  }

  /**
   * Writes the first version of the draft, from the request, the answers
   * and the existing documents the person may read. Questions left open
   * are taken as "not decided". 409 `not_ready` once drafted.
   */
  async draft(auth: AuthContext, id: string) {
    const prepared = await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const session = await this.mine(tx, auth, id, true);
      if (session.status !== 'asking' && session.status !== 'ready') throw new ConflictException({ code: 'not_ready' });
      const { open, round } = await this.questionsOf(tx, session.id);
      if (open.length > 0) {
        await this.recordAnswers(tx, auth, session, round, open.map((q) => ({ questionId: q.id, answer: null })));
      }
      const ctx = await this.contextOf(tx, auth, session);
      const qa = await this.qaOf(tx, session.id);
      const sources = await this.sourcesFor(tx, auth, session, ctx);
      return { session: await this.mine(tx, auth, id), ctx, qa, sources };
    });
    const { session, ctx, qa, sources } = prepared;
    const result = await this.ai.run(this.caller(auth), 'drafting', {
      system: systemText(ctx, DRAFT_TASK),
      messages: [{ role: 'user', content: `${conversationText(session.request, qa)}\n\n${sourcesText(sources.list)}` }],
      maxTokens: DRAFT_TOKENS,
      output: draftAnswer,
      people: sources.people,
      unit: session.id,
      timeoutMs: DRAFT_TIMEOUT_MS,
    });
    if (!result.ok) throw refused(result, session.id);
    const notDecided = qa.filter((q) => q.answer === null).map((q) => q.text);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const current = await this.unchanged(tx, auth, session);
      const version = this.versionFrom(result.data!, ctx, {}, notDecided, sources.list);
      await this.addVersion(tx, auth, current, 1, 'assistant', version, { model: result.model, aiRequestId: result.requestId });
      await this.touch(tx, current, { status: 'drafted' });
      return this.view(tx, await this.mine(tx, auth, current.id));
    });
  }

  /**
   * Asks for a change to the draft ("shorter", "add the pharmacy's role",
   * "translate to Arabic"): a new version, the others kept. In another of
   * the client's languages (`locale`), that language's text is written
   * from the draft's; the other languages are kept as they were. 409
   * `not_drafted`, `draft_too_long_for_assistant` (edit it by hand).
   */
  async revise(auth: AuthContext, id: string, input: { instruction: string; locale?: string; revision: number }) {
    const prepared = await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const session = await this.mine(tx, auth, id, true);
      if (session.revision !== input.revision) throw new ConflictException({ code: 'draft_changed' });
      if (session.status !== 'drafted') throw new ConflictException({ code: 'not_drafted' });
      const locale = input.locale ?? session.locale;
      if (!auth.tenant.locales.includes(locale)) throw new BadRequestException({ code: 'language_mismatch' });
      const latest = await this.latestVersion(tx, session.id);
      const from = latest.content[locale] && Object.keys(latest.content[locale]!).length > 0 ? locale : session.locale;
      const text = latest.content[from] ?? {};
      if (Object.values(text).reduce((n, t) => n + t.length, 0) > MAX_DRAFT_FOR_REVISION) {
        throw new ConflictException({ code: 'draft_too_long_for_assistant', max: MAX_DRAFT_FOR_REVISION });
      }
      await this.addTurn(tx, session, 'revision_request', { instruction: input.instruction, locale }, { createdBy: auth.user.id });
      const touched = await this.touch(tx, session, {});
      const ctx = await this.contextOf(tx, auth, { ...touched, locale });
      return { session: touched, ctx, latest, text, from, locale };
    });
    const { session, ctx, latest, text, from, locale } = prepared;
    const draft = draftText(ctx.sections, text, from, ctx.defaultLocale);
    const ask =
      locale === from
        ? `The change asked for:\n${asData('change asked for', input.instruction)}`
        : `Write this draft in ${locale === 'ar' ? 'Arabic' : locale === 'fr' ? 'French' : 'English'}, faithfully, keeping its marks. The person adds:\n${asData('change asked for', input.instruction)}`;
    const result = await this.ai.run(this.caller(auth), 'drafting', {
      system: systemText(ctx, REVISION_TASK),
      messages: [{ role: 'user', content: `${draft}\n\n${ask}` }],
      maxTokens: DRAFT_TOKENS,
      output: draftAnswer,
      people: [],
      unit: session.id,
      timeoutMs: DRAFT_TIMEOUT_MS,
    });
    if (!result.ok) throw refused(result, session.id);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const current = await this.unchanged(tx, auth, session);
      // The documents it drew on are those of the draft it revises.
      const version = { ...this.versionFrom(result.data!, ctx, latest.content, [], []), sources: latest.sources };
      await this.addVersion(tx, auth, current, latest.number + 1, 'assistant', version, {
        model: result.model,
        aiRequestId: result.requestId,
        keepTitle: locale !== session.locale ? latest.title : undefined,
      });
      await this.touch(tx, current, {});
      return this.view(tx, await this.mine(tx, auth, current.id));
    });
  }

  /**
   * An edit by hand: a new version with the text given for the sections
   * named, in any of the client's languages, the rest as in the latest
   * version. Checked as any document's text is. 409 `not_drafted`.
   */
  edit(auth: AuthContext, id: string, input: { content: Record<string, Record<string, string | null>>; revision: number }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const session = await this.mine(tx, auth, id, true);
      if (session.revision !== input.revision) throw new ConflictException({ code: 'draft_changed' });
      if (session.status !== 'drafted') throw new ConflictException({ code: 'not_drafted' });
      const latest = await this.latestVersion(tx, session.id);
      const [type] = await tx
        .select({ sections: documentTypes.sections })
        .from(documentTypes)
        .where(eq(documentTypes.id, session.documentTypeId));
      const keys = new Set(type.sections.map((s) => s.key));
      const content: DocumentContent = structuredClone(latest.content);
      for (const [locale, sections] of Object.entries(input.content)) {
        if (!auth.tenant.locales.includes(locale)) throw new BadRequestException({ code: 'language_mismatch' });
        const into = { ...content[locale] };
        for (const [key, raw] of Object.entries(sections)) {
          const value = checkedSection(locale, key, raw, keys);
          if (value) into[key] = value;
          else delete into[key];
        }
        content[locale] = into;
      }
      const { gaps, assumptions } = marksOf(content);
      await this.addVersion(
        tx,
        auth,
        session,
        latest.number + 1,
        'person',
        { content, title: latest.title, gaps, assumptions, sources: latest.sources },
        { model: null, aiRequestId: null },
      );
      await this.touch(tx, session, {});
      return this.view(tx, await this.mine(tx, auth, session.id));
    });
  }

  /**
   * Turns a version of the draft (the latest unless named) into a draft
   * document of the policies module, as `POST /policies/documents` would,
   * with the version's text: the document and its first version are marked
   * `ai_drafted`, and the document is an AI draft until a person takes
   * ownership of it. The owning unit must be within the caller's
   * `policies.manage`. From there it goes through review and approval as
   * any document. 409 `not_drafted`; 404 `unknown_version`.
   */
  async handOver(
    auth: AuthContext,
    id: string,
    input: Omit<CreateInput, 'typeId'> & { version?: number; revision: number },
  ) {
    const { version: wanted, revision, ...document } = input;
    const prepared = await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const session = await this.mine(tx, auth, id, true);
      if (session.revision !== revision) throw new ConflictException({ code: 'draft_changed' });
      if (session.status !== 'drafted') throw new ConflictException({ code: 'not_drafted' });
      const versions = await this.versionsOf(tx, session.id);
      const chosen = wanted === undefined ? versions[versions.length - 1] : versions.find((v) => v.number === wanted);
      if (!chosen) throw new NotFoundException({ code: 'unknown_version' });
      return { session, chosen };
    });
    const { session, chosen } = prepared;
    return this.documents.create(
      auth,
      { ...document, typeId: session.documentTypeId },
      {
        sessionId: session.id,
        content: chosen.content,
        onCreated: async (tx, doc) => {
          // In the document's transaction: the conversation, unchanged since
          // it was read, is marked handed over with it.
          const [moved] = await tx
            .update(draftingSessions)
            .set({
              status: 'handed_over',
              documentId: doc.id,
              handedOverVersion: chosen.number,
              revision: sql`${draftingSessions.revision} + 1`,
              lastActivityAt: new Date(),
            })
            .where(
              and(
                eq(draftingSessions.id, session.id),
                eq(draftingSessions.revision, session.revision),
                eq(draftingSessions.status, 'drafted'),
              ),
            )
            .returning({ id: draftingSessions.id });
          if (!moved) throw new ConflictException({ code: 'draft_changed' });
          await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'ai_draft_handed_over', 'document', doc.id, {
            sessionId: session.id,
            version: chosen.number,
            number: doc.number,
          });
        },
      },
    );
  }

  /**
   * Gives a conversation up: removed by the next daily check, with all its
   * versions (drafting/retention.ts). 409 `handed_over`.
   */
  discard(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const session = await this.mine(tx, auth, id, true);
      if (session.status === 'handed_over') throw new ConflictException({ code: 'handed_over' });
      if (session.status !== 'discarded') {
        const versions = (await this.versionsOf(tx, session.id)).length;
        await this.touch(tx, session, { status: 'discarded' });
        await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'ai_draft_discarded', 'ai_draft', session.id, { versions });
      }
    });
  }

  /**
   * Takes ownership of an AI-drafted document: its owner, or someone who
   * manages it. From then on it is no longer marked as an AI draft on its
   * face (its history still says so), and it can be sent for review. 404
   * for a document the caller does not manage; 409 `not_ai_draft`,
   * `already_owned`.
   */
  takeOwnership(auth: AuthContext, documentId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const [doc] = await tx
        .select({
          id: documents.id,
          source: documents.source,
          ownerId: documents.ownerId,
          ownerUnitId: documents.ownerUnitId,
          sessionId: documents.aiDraftSessionId,
          ownedAt: documents.aiDraftOwnedAt,
          full: fullSight(viewer),
        })
        .from(documents)
        .where(eq(documents.id, documentId))
        .for('update');
      const manages =
        !!doc &&
        (viewer.manageReach === 'all' || (Array.isArray(viewer.manageReach) && viewer.manageReach.includes(doc.ownerUnitId)));
      if (!doc || (!manages && doc.ownerId !== auth.user.id)) throw new NotFoundException();
      if (doc.source !== 'ai_drafted') throw new ConflictException({ code: 'not_ai_draft' });
      if (doc.ownedAt) throw new ConflictException({ code: 'already_owned' });
      await tx
        .update(documents)
        .set({ aiDraftOwnedBy: auth.user.id, aiDraftOwnedAt: new Date(), revision: sql`${documents.revision} + 1`, updatedAt: new Date() })
        .where(eq(documents.id, doc.id));
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'ai_draft_ownership_taken', 'document', doc.id, {
        sessionId: doc.sessionId,
      });
      return this.documents.detailOf(tx, auth, doc.id);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  private caller(auth: AuthContext) {
    return { tenant: { id: auth.tenant.id, timeZone: auth.tenant.timeZone }, user: { id: auth.user.id } };
  }

  /** The caller's own conversation, held when asked. 404 for any other. */
  private async mine(tx: Transaction, auth: AuthContext, id: string, lock = false) {
    const query = tx
      .select()
      .from(draftingSessions)
      .where(and(eq(draftingSessions.id, id), eq(draftingSessions.createdBy, auth.user.id), ne(draftingSessions.status, 'discarded')));
    const [session] = lock ? await query.for('update') : await query;
    if (!session) throw new NotFoundException();
    return session;
  }

  /** The conversation as it was read before the assistant answered, or 409. */
  private async unchanged(tx: Transaction, auth: AuthContext, before: Session) {
    const now = await this.mine(tx, auth, before.id, true);
    if (now.revision !== before.revision || now.status !== before.status) {
      throw new ConflictException({ code: 'draft_changed' });
    }
    return now;
  }

  private async touch(tx: Transaction, session: Session, set: Partial<Pick<Session, 'status' | 'rounds'>>) {
    const [row] = await tx
      .update(draftingSessions)
      .set({ ...set, revision: sql`${draftingSessions.revision} + 1`, lastActivityAt: new Date() })
      .where(eq(draftingSessions.id, session.id))
      .returning();
    return row;
  }

  private async localeOf(tx: Transaction, auth: AuthContext) {
    const [me] = await tx.select({ locale: users.preferredLocale }).from(users).where(eq(users.id, auth.user.id));
    return me?.locale && auth.tenant.locales.includes(me.locale) ? me.locale : auth.tenant.defaultLocale;
  }

  private async addTurn(
    tx: Transaction,
    session: Session,
    kind: 'questions' | 'answers' | 'revision_request',
    body: Record<string, unknown>,
    by: { aiRequestId?: string; createdBy?: string },
  ) {
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${draftingMessages.seq}), 0)::int + 1` })
      .from(draftingMessages)
      .where(eq(draftingMessages.sessionId, session.id));
    await tx.insert(draftingMessages).values({
      tenantId: session.tenantId,
      sessionId: session.id,
      seq: next,
      kind,
      body,
      aiRequestId: by.aiRequestId ?? null,
      createdBy: by.createdBy ?? null,
    });
  }

  private async recordAnswers(tx: Transaction, auth: AuthContext, session: Session, round: number, answers: Answer[]) {
    await this.addTurn(tx, session, 'answers', { round, answers }, { createdBy: auth.user.id });
    await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'ai_draft_answered', 'ai_draft', session.id, {
      round,
      answered: answers.filter((a) => a.answer !== null).length,
      notDecided: answers.filter((a) => a.answer === null).length,
    });
    await this.touch(tx, session, {});
  }

  private async turnsOf(tx: Transaction, sessionId: string) {
    return tx
      .select({
        seq: draftingMessages.seq,
        kind: draftingMessages.kind,
        body: draftingMessages.body,
        createdAt: draftingMessages.createdAt,
      })
      .from(draftingMessages)
      .where(eq(draftingMessages.sessionId, sessionId))
      .orderBy(asc(draftingMessages.seq));
  }

  /** The last round's questions, and those of them not answered yet. */
  private async questionsOf(tx: Transaction, sessionId: string) {
    const turns = await this.turnsOf(tx, sessionId);
    const asked = [...turns].reverse().find((t) => t.kind === 'questions');
    if (!asked) return { round: 0, open: [] as Question[] };
    const round = (asked.body as { round: number }).round;
    const answered = turns.some((t) => t.kind === 'answers' && (t.body as { round: number }).round === round);
    return { round, open: answered ? [] : ((asked.body as { questions: Question[] }).questions ?? []) };
  }

  /** Every question asked, with its answer. */
  private async qaOf(tx: Transaction, sessionId: string): Promise<QA[]> {
    const turns = await this.turnsOf(tx, sessionId);
    const answers = new Map<string, string | null>();
    for (const t of turns) {
      if (t.kind !== 'answers') continue;
      for (const a of (t.body as { answers: Answer[] }).answers) answers.set(a.questionId, a.answer);
    }
    return turns
      .filter((t) => t.kind === 'questions')
      .flatMap((t) => {
        const { round, questions } = t.body as { round: number; questions: Question[] };
        return questions.map((q) => ({
          round,
          text: q.text,
          reason: q.reason,
          answered: answers.has(q.id),
          answer: answers.get(q.id) ?? null,
        }));
      });
  }

  private async versionsOf(tx: Transaction, sessionId: string) {
    return tx
      .select()
      .from(draftingVersions)
      .where(eq(draftingVersions.sessionId, sessionId))
      .orderBy(asc(draftingVersions.number));
  }

  private async latestVersion(tx: Transaction, sessionId: string) {
    const versions = await this.versionsOf(tx, sessionId);
    return versions[versions.length - 1];
  }

  private async addVersion(
    tx: Transaction,
    auth: AuthContext,
    session: Session,
    number: number,
    author: 'assistant' | 'person',
    v: { content: DocumentContent; title: Localized; gaps: { section: string; text: string }[]; assumptions: { section: string; text: string }[]; sources: SourceRef[] },
    meta: { model: string | null; aiRequestId: string | null; keepTitle?: Localized },
  ) {
    await tx.insert(draftingVersions).values({
      tenantId: session.tenantId,
      sessionId: session.id,
      number,
      author,
      content: v.content,
      title: meta.keepTitle ? { ...meta.keepTitle, ...v.title } : v.title,
      gaps: v.gaps,
      assumptions: v.assumptions,
      sources: v.sources,
      model: meta.model,
      aiRequestId: meta.aiRequestId,
      createdBy: auth.user.id,
    });
    await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'ai_draft_version_created', 'ai_draft', session.id, {
      version: number,
      author,
      gaps: v.gaps.length,
      assumptions: v.assumptions.length,
      sources: v.sources.map((s) => s.number),
      model: meta.model,
      aiRequestId: meta.aiRequestId,
    });
  }

  /**
   * A version from the assistant's answer, in the context's language: the
   * sections of the type only, in its order, with the marks a reader sees;
   * every question answered "not decided" marked as a gap, where the
   * assistant left fewer gaps than there were; a required section it did
   * not write marked as a gap; text in a form a document cannot hold made
   * plain. The other languages are kept from `base`.
   */
  private versionFrom(answer: DraftAnswer, ctx: DraftingContext, base: DocumentContent, notDecided: string[], provided: { documentId: string; number: string; title: Localized | string }[]) {
    const locale = ctx.locale;
    const written = new Map(answer.sections.map((s) => [s.key, s.text]));
    const text: Record<string, string> = {};
    for (const section of ctx.sections) {
      const raw = written.get(section.key);
      let value = raw ? plain(normalizeSection(showMarks(raw, locale))) : '';
      if (!value && section.required) value = gapMark(locale, sectionName(section, locale, ctx.defaultLocale));
      if (value.length > SECTION_MAX_CHARS) value = value.slice(0, SECTION_MAX_CHARS);
      if (value) text[section.key] = value;
    }
    // "Not decided" is a marked gap in the draft, whatever the assistant did.
    const marked = marksOf({ [locale]: text }).gaps.length;
    const missing = notDecided.slice(0, Math.max(0, notDecided.length - marked));
    if (missing.length > 0) {
      const first = ctx.sections.find((s) => text[s.key]) ?? ctx.sections[0];
      text[first.key] = [text[first.key] ?? '', ...missing.map((q) => gapMark(locale, q))].filter(Boolean).join('\n\n');
    }
    const content: DocumentContent = { ...base, [locale]: text };
    const { gaps, assumptions } = marksOf(content);
    const numbers = new Set(answer.sources.map((s) => s.trim().toUpperCase()));
    const sources = provided
      .filter((s) => numbers.has(s.number.toUpperCase()))
      .map((s) => ({ documentId: s.documentId, number: s.number, title: typeof s.title === 'string' ? { [locale]: s.title } : s.title }));
    return { content, title: { [locale]: answer.title.trim().slice(0, 200) } as Localized, gaps, assumptions, sources };
  }

  /** What the assistant is given about the organization and the document. */
  private async contextOf(tx: Transaction, auth: AuthContext, session: Pick<Session, 'documentTypeId' | 'designId' | 'locale'>): Promise<DraftingContext> {
    const [tenant] = await tx
      .select({ defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, auth.tenant.id));
    const [type] = await tx
      .select({ name: documentTypes.name, sections: documentTypes.sections })
      .from(documentTypes)
      .where(eq(documentTypes.id, session.documentTypeId));
    const { profile } = await this.profiles.read(tx, auth.tenant.id);
    const design: EffectiveDesign = await this.designs.effective(tx, auth.tenant.id, session.documentTypeId);
    const units = await tx
      .select({ id: orgUnits.id, parentId: orgUnits.parentId, type: orgUnits.type, name: orgUnits.name })
      .from(orgUnits)
      .where(eq(orgUnits.active, true))
      .limit(400);
    return {
      locale: session.locale,
      defaultLocale: tenant.defaultLocale,
      typeName: pickText(type.name, session.locale, tenant.defaultLocale),
      sections: type.sections,
      profile,
      design,
      structure: structureText(units, session.locale, tenant.defaultLocale),
    };
  }

  /**
   * The existing documents the assistant reads (the spec, "What the
   * assistant may read"): in force, readable by the person (as the library
   * would show them), most like the request first, of the same type
   * preferred; their title and the published text only, in the draft's
   * language where it has it. And the names of their owners, removed before
   * anything is sent.
   */
  private async sourcesFor(tx: Transaction, auth: AuthContext, session: Session, ctx: DraftingContext) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const rows = await tx
      .select({
        id: documents.id,
        number: documents.number,
        title: documents.title,
        keywords: documents.keywords,
        typeId: documents.typeId,
        ownerId: documents.ownerId,
        content: documentVersions.content,
      })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.id, documents.publishedVersionId))
      .where(and(eq(documents.status, 'active'), sql`(${readsPublished(viewer)} or ${fullSight(viewer)})`))
      .limit(500);
    const words = new Set(
      session.request
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4),
    );
    const scored = rows
      .map((r) => {
        const haystack = [...Object.values(r.title), ...r.keywords].join(' ').toLowerCase();
        const hits = [...words].filter((w) => haystack.includes(w)).length;
        return { r, score: hits * 2 + (r.typeId === session.documentTypeId && hits > 0 ? 1 : 0) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.r.number.localeCompare(b.r.number))
      .slice(0, MAX_SOURCES);
    const list: (Source & { title: string })[] = scored.map(({ r }) => {
      const locale = r.content[ctx.locale] ? ctx.locale : r.content[ctx.defaultLocale] ? ctx.defaultLocale : Object.keys(r.content)[0];
      const text = Object.values(r.content[locale] ?? {}).join('\n\n');
      return { documentId: r.id, number: r.number, title: pickText(r.title, ctx.locale, ctx.defaultLocale), text };
    });
    const owners = scored.length
      ? await tx.select({ name: users.name }).from(users).where(inArray(users.id, scored.map((s) => s.r.ownerId)))
      : [];
    const people = owners.flatMap((o) => Object.values(o.name).filter((n): n is string => typeof n === 'string'));
    return { list, people };
  }

  private async view(tx: Transaction, session: Session) {
    const turns = await this.turnsOf(tx, session.id);
    const { open } = await this.questionsOf(tx, session.id);
    const versions = await this.versionsOf(tx, session.id);
    return {
      id: session.id,
      status: session.status,
      documentTypeId: session.documentTypeId,
      locale: session.locale,
      request: session.request,
      rounds: session.rounds,
      maxRounds: MAX_ROUNDS,
      designId: session.designId,
      documentId: session.documentId,
      handedOverVersion: session.handedOverVersion,
      revision: session.revision,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      openQuestions: open,
      turns,
      versions: versions.map((v) => ({
        number: v.number,
        author: v.author,
        title: v.title,
        content: v.content,
        gaps: v.gaps,
        assumptions: v.assumptions,
        sources: v.sources,
        model: v.model,
        createdAt: v.createdAt,
      })),
    };
  }
}

const sectionName = (s: DocumentSection, locale: string, defaultLocale: string) => pickText(s.name, locale, defaultLocale);

/**
 * Text the assistant wrote, made into what a document's section may hold
 * (policies/content.ts): what would be read as markup it does not allow is
 * written plainly. What still cannot be held is dropped, and the section
 * marked as a gap by the caller.
 */
function plain(text: string): string {
  let out = text
    .replace(/<(?=[A-Za-z/!?])/g, '‹')
    .replace(/!\[/g, '[')
    .replace(/\]\(/g, '] (')
    .replace(/\]\[/g, '] [')
    .replace(/\]([ \t]*):/g, ']$1 :')
    .replace(/`/g, '\'')
    .replace(/^\s*~~~/gm, '')
    .replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, '$1: //')
    .replace(/\bwww\./gi, 'www .')
    .replace(/^(\s*)>/gm, '$1')
    .replace(/^(\s*)\|/gm, '$1')
    .replace(/^(\s{0,3})#{4,6}/gm, '$1###');
  out = out.replace(/([a-z0-9._+-]+)@([a-z0-9_-]+\.)/gi, '$1 (at) $2');
  return markupProblem(out) ? '' : out;
}

/** The organization's units, as an indented list in one language. */
function structureText(
  units: { id: string; parentId: string | null; type: string; name: Localized }[],
  locale: string,
  defaultLocale: string,
): string {
  const children = new Map<string | null, typeof units>();
  for (const u of units) children.set(u.parentId, [...(children.get(u.parentId) ?? []), u]);
  const known = new Set(units.map((u) => u.id));
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const u of children.get(parent) ?? []) {
      lines.push(`${'  '.repeat(depth)}- ${pickText(u.name, locale, defaultLocale)} (${u.type})`);
      if (depth < 6) walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  // Units whose parent is not among those read.
  for (const u of units) if (u.parentId && !known.has(u.parentId)) lines.push(`- ${pickText(u.name, locale, defaultLocale)} (${u.type})`);
  return lines.join('\n');
}
