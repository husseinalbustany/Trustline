import { and, eq, inArray, sql } from 'drizzle-orm';
import { contentHash } from '../approvals/signatures.js';
import type { Locale, Localized } from '../i18n/locales.js';
import { addMonths, dayOf, shiftDay } from '../i18n/time-zones.js';
import { signedImport, signedVersion } from '../policies/signed-content.js';
import type { Transaction } from './client.js';
import {
  approvalRoutes,
  approvalRuns,
  approvalRunSteps,
  documentAcknowledgements,
  documentAudiences,
  documentCategories,
  documentImportBatches,
  documentImports,
  documentReviewRounds,
  documents,
  documentTypes,
  documentVersions,
  orgUnits,
  referenceCounters,
  roleAssignments,
  roles,
  signatures,
  users,
  type DocumentContent,
} from './schema.js';

/**
 * A few example documents for each demo client, in different states, worded
 * for any organization: a published policy, a published procedure that asks
 * for acknowledgement with a second version in review, a draft work
 * instruction, an approved procedure scheduled for a later day, and a
 * restricted policy past its review date, and a procedure imported as
 * approved before Trustline, its review coming up. With three fictional
 * members of staff, invited and never signed in, who wrote, reviewed,
 * approved and imported them.
 * Nothing is added to a client that already has a document of that number,
 * so running the seed again changes nothing.
 */

type Text = Record<Locale, string>;
type Sections = Record<string, Text>;

const t = (en: string, ar: string, fr: string): Text => ({ en, ar, fr });

const PEOPLE = [
  {
    key: 'owner',
    email: 'document.owner@example.invalid',
    name: t('Example document owner', 'المسؤول عن الوثائق (مثال)', 'Responsable documentaire (exemple)'),
    role: 'quality_officer',
  },
  {
    key: 'reviewer',
    email: 'document.reviewer@example.invalid',
    name: t('Example reviewer', 'مُراجِع الوثائق (مثال)', 'Vérificateur (exemple)'),
    role: 'quality_officer',
  },
  {
    key: 'approver',
    email: 'document.approver@example.invalid',
    name: t('Example approver', 'مُعتمِد الوثائق (مثال)', 'Approbateur (exemple)'),
    // Approves documents everywhere, as the Approving authority the
    // starting route ends with; not an administrator, which the admin
    // portal gives each client itself.
    role: 'department_manager',
    alsoRole: 'approving_authority',
  },
] as const;

type Example = {
  type: string;
  category: string;
  number: string;
  title: Text;
  restricted?: boolean;
  acknowledgementRequired?: boolean;
  /** What becomes of it. */
  state: 'published' | 'published_with_review' | 'draft' | 'scheduled';
  /** For a published one: how many days ago it took effect. */
  effectiveDaysAgo?: number;
  content: Sections;
  /** For `published_with_review`: the second version's changes. */
  next?: { content: Sections; changeSummary: Text };
};

const EXAMPLES: Example[] = [
  {
    type: 'policy',
    category: 'GOV',
    number: 'POL-GOV-001',
    title: t('Document control', 'ضبط الوثائق', 'Maîtrise des documents'),
    state: 'published',
    effectiveDaysAgo: 200,
    content: {
      purpose: t(
        'To make sure everyone works from the current, approved version of every policy, procedure and work instruction.',
        'ضمان أن يعمل الجميع وفق الإصدار الساري والمعتمد من كل سياسة وإجراء وتعليمات عمل.',
        'Garantir que chacun travaille avec la version en vigueur et approuvée de chaque politique, procédure et instruction de travail.',
      ),
      scope: t(
        'All controlled documents of the organization, and everyone who writes, approves or uses them.',
        'جميع الوثائق المضبوطة في المنشأة، وكل من يكتبها أو يعتمدها أو يستخدمها.',
        'Tous les documents maîtrisés de l’établissement, et toutes les personnes qui les rédigent, les approuvent ou les utilisent.',
      ),
      policy_statements: t(
        '1. Every controlled document has a number, an owner and a review date.\n2. A document is approved before it is published, and the approval is signed.\n3. Only the version in Trustline is current. **Printed copies are not controlled.**\n4. Each document is reviewed by its review date at the latest.',
        '1. لكل وثيقة مضبوطة رقم والمسؤول عنها وتاريخ مراجعة.\n2. تُعتمد الوثيقة قبل نشرها، ويكون الاعتماد موقّعًا.\n3. الإصدار المنشور في Trustline وحده هو الساري. **النسخ المطبوعة غير مضبوطة.**\n4. تُراجع كل وثيقة في موعد أقصاه تاريخ مراجعتها.',
        '1. Chaque document maîtrisé a un numéro, un responsable et une date de révision.\n2. Un document est approuvé avant d’être publié, et l’approbation est signée.\n3. Seule la version publiée dans Trustline fait foi. **Les copies imprimées ne sont pas maîtrisées.**\n4. Chaque document est révisé au plus tard à sa date de révision.',
      ),
      responsibilities: t(
        '- **Owners** keep their documents current and review them on time.\n- **Reviewers and approvers** check a document before it is published.\n- **Everyone** reads and follows the documents that apply to their work.',
        '- **المسؤولون عن الوثائق** يحافظون على تحديث وثائقهم ويراجعونها في موعدها.\n- **المراجعون والمعتمدون** يتحققون من الوثيقة قبل نشرها.\n- **الجميع** يقرؤون الوثائق التي تنطبق على عملهم ويلتزمون بها.',
        '- **Les responsables** tiennent leurs documents à jour et les révisent à temps.\n- **Les vérificateurs et les approbateurs** contrôlent un document avant sa publication.\n- **Chacun** lit et applique les documents qui concernent son travail.',
      ),
      references: t('ISO 9001 7.5', 'ISO 9001 7.5', 'ISO 9001 7.5'),
    },
  },
  {
    type: 'procedure',
    category: 'SAF',
    number: 'PRC-SAF-001',
    title: t('Reporting a hazard', 'الإبلاغ عن مصادر الخطر', 'Signalement d’un danger'),
    state: 'published_with_review',
    acknowledgementRequired: true,
    effectiveDaysAgo: 90,
    content: {
      purpose: t(
        'To report a hazard as soon as it is seen, so that it is dealt with before anyone is harmed.',
        'الإبلاغ عن مصدر الخطر فور ملاحظته، لمعالجته قبل أن يتضرر أي شخص.',
        'Signaler un danger dès qu’il est repéré, pour qu’il soit traité avant que quiconque ne soit blessé.',
      ),
      scope: t(
        'Everyone who works for or on behalf of the organization, on any site.',
        'كل من يعمل لدى المنشأة أو نيابة عنها، في أي مرفق من مرافقها.',
        'Toute personne qui travaille pour l’établissement ou en son nom, sur tous les sites.',
      ),
      responsibilities: t(
        '- **Whoever sees a hazard** makes the area safe if they can, and reports it.\n- **The manager of the area** decides what is done and by when.',
        '- **من يلاحظ الخطر** يؤمّن المكان إن استطاع، ويبلّغ عنه.\n- **المسؤول عن المكان** يقرر ما يجب فعله وموعده.',
        '- **Qui voit un danger** sécurise la zone s’il le peut, et le signale.\n- **Le responsable de la zone** décide de ce qui est fait et dans quel délai.',
      ),
      steps: t(
        '1. Make the area safe if you can do so without risk.\n2. Report the hazard in Trustline, saying where it is and what you saw.\n3. Tell the manager of the area.\n4. Follow the report until it is closed.',
        '1. أمّن المكان إن أمكنك ذلك دون خطر.\n2. أبلغ عن الخطر في Trustline مع ذكر مكانه وما رأيته.\n3. أخبر المسؤول عن المكان.\n4. تابع البلاغ حتى إغلاقه.',
        '1. Sécurisez la zone si vous pouvez le faire sans risque.\n2. Signalez le danger dans Trustline en indiquant où il se trouve et ce que vous avez vu.\n3. Prévenez le responsable de la zone.\n4. Suivez le signalement jusqu’à sa clôture.',
      ),
      records: t(
        'The report in Trustline, with its follow-up.',
        'البلاغ في Trustline ومتابعته.',
        'Le signalement dans Trustline, avec son suivi.',
      ),
    },
    next: {
      content: {
        steps: t(
          '1. Make the area safe if you can do so without risk.\n2. Report the hazard in Trustline straight away, saying where it is and what you saw.\n3. Tell the manager of the area in person.\n4. Follow the report until it is closed.',
          '1. أمّن المكان إن أمكنك ذلك دون خطر.\n2. أبلغ عن الخطر في Trustline فورًا مع ذكر مكانه وما رأيته.\n3. أخبر المسؤول عن المكان شخصيًا.\n4. تابع البلاغ حتى إغلاقه.',
          '1. Sécurisez la zone si vous pouvez le faire sans risque.\n2. Signalez immédiatement le danger dans Trustline en indiquant où il se trouve et ce que vous avez vu.\n3. Prévenez en personne le responsable de la zone.\n4. Suivez le signalement jusqu’à sa clôture.',
        ),
      },
      changeSummary: t(
        'Hazards are reported straight away, and the manager of the area is told in person.',
        'يُبلَّغ عن مصدر الخطر فورًا، ويُخبَر المسؤول عن المكان شخصيًا.',
        'Les dangers sont signalés immédiatement, et le responsable de la zone est prévenu en personne.',
      ),
    },
  },
  {
    type: 'work_instruction',
    category: 'OPS',
    number: 'WI-OPS-001',
    title: t('Opening the workplace', 'فتح مكان العمل', 'Ouverture du lieu de travail'),
    state: 'draft',
    content: {
      purpose: t(
        'To open the workplace safely at the start of each day.',
        'فتح مكان العمل بأمان في بداية كل يوم.',
        'Ouvrir le lieu de travail en sécurité au début de chaque journée.',
      ),
      steps: t(
        '1. Check that exits are clear.\n2. Switch on the shared equipment and check that it starts.\n3. Note anything out of order and report it.',
        '1. تأكد من أن المخارج خالية.\n2. شغّل المعدات المشتركة وتأكد من أنها تعمل.\n3. سجّل أي عطل وأبلغ عنه.',
        '1. Vérifiez que les sorties sont dégagées.\n2. Mettez en marche les équipements partagés et vérifiez qu’ils démarrent.\n3. Notez toute anomalie et signalez-la.',
      ),
      safety_notes: t(
        'Do not use equipment that fails its check.',
        'لا تستخدم معدات لم تجتز الفحص.',
        'N’utilisez pas un équipement qui n’a pas passé sa vérification.',
      ),
    },
  },
  {
    type: 'procedure',
    category: 'QUA',
    number: 'PRC-QUA-001',
    title: t('Handling a complaint', 'التعامل مع الشكاوى', 'Traitement d’une réclamation'),
    state: 'scheduled',
    content: {
      purpose: t(
        'To answer every complaint fairly and on time.',
        'الرد على كل شكوى بإنصاف وفي الوقت المحدد.',
        'Répondre à chaque réclamation de manière équitable et dans les délais.',
      ),
      scope: t(
        'Complaints from anyone the organization serves, however they are made.',
        'الشكاوى الواردة من أي شخص تخدمه المنشأة، بأي وسيلة قُدّمت.',
        'Les réclamations de toute personne bénéficiant des services de l’établissement, quel que soit le moyen utilisé.',
      ),
      responsibilities: t(
        '- **Whoever receives a complaint** records it the same day.\n- **The quality team** makes sure it is answered.',
        '- **من يتلقى الشكوى** يسجّلها في اليوم نفسه.\n- **فريق الجودة** يتأكد من الرد عليها.',
        '- **Qui reçoit une réclamation** l’enregistre le jour même.\n- **L’équipe qualité** veille à ce qu’une réponse soit donnée.',
      ),
      steps: t(
        '1. Record the complaint and thank the person who made it.\n2. Acknowledge it within two working days.\n3. Look into it and answer within twenty working days.\n4. Record what was learned.',
        '1. سجّل الشكوى واشكر مقدّمها.\n2. أكّد استلامها خلال يومي عمل.\n3. ادرسها ورُدّ عليها خلال عشرين يوم عمل.\n4. سجّل الدروس المستفادة.',
        '1. Enregistrez la réclamation et remerciez son auteur.\n2. Accusez-en réception sous deux jours ouvrés.\n3. Instruisez-la et répondez sous vingt jours ouvrés.\n4. Consignez les enseignements tirés.',
      ),
    },
  },
  {
    type: 'policy',
    category: 'INF',
    number: 'POL-INF-001',
    title: t('Information security', 'أمن المعلومات', 'Sécurité de l’information'),
    restricted: true,
    state: 'published',
    // Its review date has passed: what the summary's measure counts.
    effectiveDaysAgo: 3 * 365 + 10,
    content: {
      purpose: t(
        'To protect the organization’s information from loss, misuse and disclosure.',
        'حماية معلومات المنشأة من الفقد وسوء الاستخدام والإفصاح.',
        'Protéger les informations de l’établissement contre la perte, le mauvais usage et la divulgation.',
      ),
      scope: t(
        'All information the organization holds, in any form, and everyone who uses it.',
        'جميع المعلومات التي تحتفظ بها المنشأة بأي شكل، وكل من يستخدمها.',
        'Toutes les informations détenues par l’établissement, sous toutes leurs formes, et toutes les personnes qui les utilisent.',
      ),
      policy_statements: t(
        '1. Information is shared only with those who need it for their work.\n2. Passwords are never shared or written down.\n3. A lost device or a suspected breach is reported at once.',
        '1. لا تُشارك المعلومات إلا مع من يحتاج إليها في عمله.\n2. لا تُشارك كلمات المرور ولا تُكتب أبدًا.\n3. يُبلَّغ فورًا عن فقد أي جهاز أو الاشتباه في أي اختراق.',
        '1. Les informations ne sont partagées qu’avec ceux qui en ont besoin pour leur travail.\n2. Les mots de passe ne sont jamais partagés ni écrits.\n3. La perte d’un appareil ou un soupçon de violation est signalé immédiatement.',
      ),
      responsibilities: t(
        '- **Managers** decide who may see the information of their area.\n- **Everyone** protects what they are given access to.',
        '- **المديرون** يحددون من يحق له الاطلاع على معلومات مجالهم.\n- **الجميع** يحمون ما أُتيح لهم الوصول إليه.',
        '- **Les responsables** décident qui peut voir les informations de leur domaine.\n- **Chacun** protège ce à quoi il a accès.',
      ),
    },
  },
];

const inLanguages = (text: Text, locales: Locale[]) =>
  Object.fromEntries(locales.map((l) => [l, text[l]])) as Localized;

const contentIn = (sections: Sections, locales: Locale[]): DocumentContent =>
  Object.fromEntries(
    locales.map((l) => [
      l,
      Object.fromEntries(Object.entries(sections).map(([key, text]) => [key, text[l]])),
    ]),
  );

/**
 * Adds the examples to one demo client, as the owner role (which row-level
 * security does not hold), in the seed's transaction for that client.
 */
export async function seedDocuments(
  tx: Transaction,
  tenant: {
    id: string;
    locales: Locale[];
    defaultLocale: Locale;
    timeZone: string;
    qualityUnitCode: string;
  },
) {
  const tenantId = tenant.id;
  const [unit] = await tx
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(and(eq(orgUnits.tenantId, tenantId), eq(orgUnits.code, tenant.qualityUnitCode)));
  if (!unit) return;

  // The three people, with a role each for the whole organization.
  const people: Record<string, string> = {};
  for (const person of PEOPLE) {
    await tx
      .insert(users)
      .values({
        tenantId,
        email: person.email,
        name: inLanguages(person.name, tenant.locales),
        orgUnitId: unit.id,
        status: 'invited',
      })
      .onConflictDoNothing({ target: [users.tenantId, users.email] });
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, person.email)));
    for (const code of [person.role, 'alsoRole' in person ? person.alsoRole : null]) {
      if (!code) continue;
      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), eq(roles.code, code)));
      if (!role) continue;
      await tx
        .insert(roleAssignments)
        .values({ tenantId, userId: user.id, roleId: role.id, orgUnitId: null })
        .onConflictDoNothing();
    }
    people[person.key] = user.id;
  }

  const typeRows = await tx
    .select({ id: documentTypes.id, code: documentTypes.code, sections: documentTypes.sections, months: documentTypes.defaultReviewMonths })
    .from(documentTypes)
    .where(eq(documentTypes.tenantId, tenantId));
  const categoryRows = await tx
    .select({ id: documentCategories.id, code: documentCategories.code })
    .from(documentCategories)
    .where(eq(documentCategories.tenantId, tenantId));
  const typeOf = new Map(typeRows.map((r) => [r.code, r]));
  const categoryOf = new Map(categoryRows.map((r) => [r.code, r.id]));
  const existing = new Set(
    (
      await tx
        .select({ number: documents.number })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            inArray(
              documents.number,
              EXAMPLES.map((e) => e.number),
            ),
          ),
        )
    ).map((d) => d.number),
  );
  const now = new Date();
  const today = dayOf(now, tenant.timeZone);
  const at = (day: string) => new Date(`${day}T09:00:00Z`);

  for (const example of EXAMPLES) {
    if (existing.has(example.number)) continue;
    const type = typeOf.get(example.type);
    const categoryId = categoryOf.get(example.category);
    if (!type || !categoryId) continue;
    const [route] = await tx
      .select({ id: approvalRoutes.id })
      .from(approvalRoutes)
      .where(and(eq(approvalRoutes.tenantId, tenantId), eq(approvalRoutes.documentTypeId, type.id)));

    // Its number, from the series it belongs to, which is raised past it.
    const series = example.number.slice(0, example.number.lastIndexOf('-'));
    const n = Number(example.number.slice(example.number.lastIndexOf('-') + 1));
    await tx
      .insert(referenceCounters)
      .values({ tenantId, prefix: series, year: 0, lastNumber: n })
      .onConflictDoUpdate({
        target: [referenceCounters.tenantId, referenceCounters.prefix, referenceCounters.year],
        set: { lastNumber: sql`greatest(${referenceCounters.lastNumber}, ${n})` },
      });

    const published = example.state === 'published' || example.state === 'published_with_review';
    const effectiveOn = published ? shiftDay(today, -(example.effectiveDaysAgo ?? 30)) : null;
    const preparedOn = effectiveOn ?? shiftDay(today, -5);
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId,
        number: example.number,
        typeId: type.id,
        categoryId,
        title: inLanguages(example.title, tenant.locales),
        ownerId: people.owner,
        ownerUnitId: unit.id,
        confidentiality: example.restricted ? 'restricted' : 'all_staff',
        keywords: [],
        references: example.content.references ? [example.content.references.en] : [],
        reviewMonths: type.months,
        createdBy: people.owner,
        createdAt: at(shiftDay(preparedOn, -10)),
      })
      .returning({ id: documents.id, number: documents.number });
    await tx.insert(documentAudiences).values({
      tenantId,
      documentId: doc.id,
      // A restricted one applies to the quality department only.
      orgUnitId: example.restricted ? unit.id : null,
      roleId: null,
    });

    /** A version, approved through both steps with signatures when asked. */
    const addVersion = async (input: {
      version: number;
      content: DocumentContent;
      changeSummary: Localized | null;
      status: 'draft' | 'in_review' | 'approved' | 'published' | 'superseded';
      on: string;
      decided: 0 | 1 | 2;
      effectiveOn?: string | null;
    }) => {
      const [version] = await tx
        .insert(documentVersions)
        .values({
          tenantId,
          documentId: doc.id,
          version: input.version,
          status: input.status,
          sections: type.sections,
          content: input.content,
          changeSummary: input.changeSummary,
          preparedBy: people.owner,
          preparedAt: at(shiftDay(input.on, -7)),
          contributors: [people.owner],
          effectiveOn: input.effectiveOn ?? null,
          scheduledBy: input.status === 'approved' ? people.owner : null,
          approvedAt: input.decided === 2 ? at(shiftDay(input.on, -1)) : null,
          publishedAt: input.status === 'published' || input.status === 'superseded' ? at(input.on) : null,
          publishedBy: input.status === 'published' || input.status === 'superseded' ? people.owner : null,
          acknowledgementRequired: example.acknowledgementRequired ?? false,
          // Recorded when sent, and signed with it (the seed sets no
          // authoritative language: the client's main one).
          authoritativeLocale: input.status === 'draft' ? null : tenant.defaultLocale,
          signsAuthoritativeLocale: input.status !== 'draft',
        })
        .returning();
      if (input.status === 'draft' || !route) return version;
      const hash = contentHash(signedVersion(doc, version));
      const [run] = await tx
        .insert(approvalRuns)
        .values({
          tenantId,
          routeId: route.id,
          subjectType: 'document_version',
          subjectId: version.id,
          status: input.decided === 2 ? 'approved' : 'in_progress',
          currentPosition: input.decided === 2 ? null : input.decided + 1,
          startedBy: people.owner,
          startedAt: at(shiftDay(input.on, -6)),
          completedAt: input.decided === 2 ? at(shiftDay(input.on, -1)) : null,
        })
        .returning({ id: approvalRuns.id });
      // What its reviewers read, as sending it for review keeps it.
      await tx.insert(documentReviewRounds).values({
        tenantId,
        versionId: version.id,
        runId: run.id,
        sections: version.sections,
        content: version.content,
        changeSummary: version.changeSummary,
        createdAt: at(shiftDay(input.on, -6)),
      });
      for (const [i, who] of (['reviewer', 'approver'] as const).entries()) {
        const decided = i < input.decided;
        const signedAt = at(shiftDay(input.on, i === 0 ? -4 : -1));
        const [signature] = decided
          ? await tx
              .insert(signatures)
              .values({
                tenantId,
                userId: people[who],
                meaning: i === 0 ? 'reviewed' : 'approved',
                subjectType: 'document_version',
                subjectId: version.id,
                contentHash: hash,
                signedAt,
              })
              .returning({ id: signatures.id })
          : [null];
        const current = i === input.decided;
        await tx.insert(approvalRunSteps).values({
          tenantId,
          runId: run.id,
          position: i + 1,
          kind: i === 0 ? 'review' : 'approve',
          // Named in the run as the person who decided it, or who is to.
          assigneeUserId: people[who],
          dueInDays: 7,
          status: decided ? 'approved' : current ? 'pending' : 'waiting',
          activatedAt: decided || current ? at(shiftDay(input.on, i === 0 ? -6 : -4)) : null,
          dueAt: decided || current ? at(shiftDay(input.on, i === 0 ? 1 : 3)) : null,
          decidedBy: decided ? people[who] : null,
          decidedAt: decided ? signedAt : null,
          signatureId: signature?.id ?? null,
        });
      }
      return version;
    };

    const content = contentIn(example.content, tenant.locales);
    if (example.state === 'draft') {
      await addVersion({ version: 1, content, changeSummary: null, status: 'draft', on: today, decided: 0 });
      continue;
    }
    if (example.state === 'scheduled') {
      await addVersion({
        version: 1,
        content,
        changeSummary: null,
        status: 'approved',
        on: today,
        decided: 2,
        effectiveOn: shiftDay(today, 14),
      });
      continue;
    }
    const first = await addVersion({
      version: 1,
      content,
      changeSummary: null,
      status: 'published',
      on: effectiveOn!,
      decided: 2,
      effectiveOn,
    });
    await tx
      .update(documents)
      .set({
        status: 'active',
        publishedVersionId: first.id,
        nextReviewOn: addMonths(effectiveOn!, type.months),
        lastReviewedOn: effectiveOn,
      })
      .where(eq(documents.id, doc.id));
    if (example.acknowledgementRequired) {
      // The example people were asked; the reviewer has acknowledged.
      for (const key of ['owner', 'reviewer', 'approver'] as const) {
        const acknowledged = key === 'reviewer';
        const [signature] = acknowledged
          ? await tx
              .insert(signatures)
              .values({
                tenantId,
                userId: people[key],
                meaning: 'acknowledged',
                subjectType: 'document_version',
                subjectId: first.id,
                contentHash: contentHash(signedVersion(doc, first)),
                signedAt: at(shiftDay(effectiveOn!, 2)),
              })
              .returning({ id: signatures.id })
          : [null];
        await tx.insert(documentAcknowledgements).values({
          tenantId,
          versionId: first.id,
          userId: people[key],
          assignedAt: at(effectiveOn!),
          dueOn: shiftDay(effectiveOn!, 14),
          acknowledgedAt: acknowledged ? at(shiftDay(effectiveOn!, 2)) : null,
          signatureId: signature?.id ?? null,
          remindedAt: acknowledged ? null : at(shiftDay(effectiveOn!, 7)),
          overdueRemindedAt: acknowledged ? null : at(shiftDay(effectiveOn!, 15)),
        });
      }
    }
    if (example.next) {
      await addVersion({
        version: 2,
        content: contentIn({ ...example.content, ...example.next.content }, tenant.locales),
        changeSummary: inLanguages(example.next.changeSummary, tenant.locales),
        status: 'in_review',
        on: today,
        decided: 0,
      });
    }
  }

  await seedImported(tx, tenant, {
    unitId: unit.id,
    importerId: people.owner,
    type: typeOf.get(IMPORTED.type),
    categoryId: categoryOf.get(IMPORTED.category),
    today,
  });
}

/**
 * A procedure of the organization's existing library, imported as
 * approved before Trustline by the example document owner: its number as
 * the original gives it, its revision, approval and next review (due in
 * about a month, when it is to be re-issued through the route), and only
 * some of its type's sections, as an original rarely has them all.
 */
const IMPORTED = {
  type: 'procedure',
  category: 'OPS',
  number: 'SOP/OPS/012',
  revisionLabel: 'Rev. 4',
  title: t('Cleaning shared equipment', 'تنظيف المعدات المشتركة', 'Nettoyage des équipements partagés'),
  approvedBy: t('Operations Director', 'مدير العمليات', 'Directeur des opérations'),
  originalKeptAt: t(
    'Quality office, document control cabinet',
    'مكتب الجودة، خزانة ضبط الوثائق',
    'Bureau qualité, armoire de maîtrise documentaire',
  ),
  content: {
    purpose: t(
      'To clean shared equipment the same way every time, so that it is safe for the next person.',
      'تنظيف المعدات المشتركة بالطريقة نفسها في كل مرة، لتكون آمنة لمن يستخدمها بعدك.',
      'Nettoyer les équipements partagés de la même façon à chaque fois, pour qu’ils soient sûrs pour la personne suivante.',
    ),
    steps: t(
      '1. Switch the equipment off.\n2. Wipe every surface that is touched with the approved product.\n3. Leave it to dry.\n4. Sign the cleaning record.',
      '1. أطفئ المعدات.\n2. امسح كل سطح يُلمس بالمنتج المعتمد.\n3. اتركها حتى تجف.\n4. وقّع سجل التنظيف.',
      '1. Éteignez l’équipement.\n2. Essuyez toutes les surfaces touchées avec le produit approuvé.\n3. Laissez sécher.\n4. Signez le registre de nettoyage.',
    ),
    records: t(
      'The cleaning record kept beside the equipment.',
      'سجل التنظيف المحفوظ بجانب المعدات.',
      'Le registre de nettoyage conservé à côté de l’équipement.',
    ),
  } as Sections,
};

async function seedImported(
  tx: Transaction,
  tenant: { id: string; locales: Locale[]; defaultLocale: Locale; timeZone: string },
  at: {
    unitId: string;
    importerId: string;
    type: { id: string; sections: { key: string; name: Localized; required: boolean }[]; months: number } | undefined;
    categoryId: string | undefined;
    today: string;
  },
) {
  const tenantId = tenant.id;
  const { type, categoryId, today } = at;
  if (!type || !categoryId) return;
  const [exists] = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.number, IMPORTED.number)));
  if (exists) return;
  const importedOn = shiftDay(today, -20);
  const importedAt = new Date(`${importedOn}T09:00:00Z`);
  const nextReviewOn = shiftDay(today, 30);
  const approvedOn = addMonths(nextReviewOn, -type.months);
  const effectiveOn = shiftDay(approvedOn, 14);
  const [doc] = await tx
    .insert(documents)
    .values({
      tenantId,
      number: IMPORTED.number,
      typeId: type.id,
      categoryId,
      title: inLanguages(IMPORTED.title, tenant.locales),
      ownerId: at.importerId,
      ownerUnitId: at.unitId,
      confidentiality: 'all_staff',
      reviewMonths: type.months,
      source: 'imported',
      createdBy: at.importerId,
      createdAt: importedAt,
    })
    .returning({ id: documents.id, number: documents.number });
  await tx.insert(documentAudiences).values({ tenantId, documentId: doc.id, orgUnitId: null, roleId: null });
  const content = contentIn(IMPORTED.content, tenant.locales);
  const [version] = await tx
    .insert(documentVersions)
    .values({
      tenantId,
      documentId: doc.id,
      version: 1,
      status: 'published',
      source: 'imported',
      sections: type.sections,
      content,
      preparedBy: at.importerId,
      preparedAt: importedAt,
      contributors: [at.importerId],
      effectiveOn,
      publishedAt: importedAt,
      publishedBy: at.importerId,
      authoritativeLocale: tenant.defaultLocale,
      signsAuthoritativeLocale: true,
    })
    .returning();
  await tx
    .update(documents)
    .set({ status: 'active', publishedVersionId: version.id, nextReviewOn, lastReviewedOn: null })
    .where(eq(documents.id, doc.id));
  const original = {
    numberAsGiven: IMPORTED.number,
    revisionLabel: IMPORTED.revisionLabel,
    approvedOn,
    // As the original says it, in the language it is written in.
    approvedBy: IMPORTED.approvedBy[tenant.defaultLocale],
    originalKeptAt: inLanguages(IMPORTED.originalKeptAt, tenant.locales),
    effectiveOn,
    nextReviewOn,
  };
  const hash = contentHash(signedImport(doc, version, original));
  const [signature] = await tx
    .insert(signatures)
    .values({
      tenantId,
      userId: at.importerId,
      meaning: 'imported',
      subjectType: 'document_version',
      subjectId: version.id,
      contentHash: hash,
      signedAt: importedAt,
    })
    .returning({ id: signatures.id });
  const [batch] = await tx
    .insert(documentImportBatches)
    .values({
      tenantId,
      importedBy: at.importerId,
      importedAt,
      size: 1,
      listHash: contentHash([
        { index: 0, documentId: doc.id, number: doc.number, versionId: version.id, contentHash: hash },
      ]),
    })
    .returning({ id: documentImportBatches.id });
  const written = new Set(Object.keys(IMPORTED.content));
  await tx.insert(documentImports).values({
    tenantId,
    batchId: batch.id,
    batchIndex: 0,
    documentId: doc.id,
    versionId: version.id,
    ...original,
    sectionsNotWritten: type.sections.filter((s) => !written.has(s.key)).map((s) => s.key),
    signatureId: signature.id,
    importedBy: at.importerId,
    importedAt,
  });
}
