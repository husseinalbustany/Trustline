import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  riskAppetite,
  riskBand,
  riskControlEffectiveness,
  riskControlHierarchy,
  riskControlKind,
  riskRatingKind,
  riskReviewOutcome,
  riskStatus,
  riskIncidentLinkKind,
  riskTreatment,
  type RiskDomainDescriptors,
} from '../database/schema.js';
import { localizedText, optionalLocalizedText } from '../i18n/locales.js';
import { line, text } from '../i18n/text.js';

/**
 * What the routes of the risks module take. Every body is a strict object
 * (an unknown field is refused with 400), every text is checked for
 * control characters, and nothing reaches a query before it has passed
 * here. Whether text fits the client's languages is the services' to
 * check, with `fitsLanguages`.
 */

export function parse<T extends z.ZodType>(schema: T, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data as z.infer<T>;
}

/** An id in the address that is not one is a record that does not exist. */
export function parseId(id: string) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundException();
  return parsed.data;
}

/** The revision of the record the caller was looking at. Required. */
const revision = z.number().int().min(1);

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

// An empty value in the address (`?status=`) means the filter is not set.
const blankAsUnset = (query: unknown) =>
  query && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''))
    : query;

/** A day on the client's calendar. */
const day = z.iso.date();

const band = z.enum(riskBand.enumValues);
const level = z.number().int().min(1).max(6);
const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

/** A name: one line per language, in the client's default one. */
const name = localizedText(200);
/** Wording of several lines, in any of the client's languages. */
const wording = optionalLocalizedText(1000);

/**
 * Text that must be written, in at least one of the client's languages
 * (business decision 14), of several lines.
 */
const requiredText = (max: number) =>
  optionalLocalizedText(max).refine((v) => v !== null);

// The settings.

export const settingsSchema = z
  .strictObject({
    revision,
    inherentRequired: z.boolean().optional(),
    // Null unlinks it.
    frameworkDocumentId: z.uuid().nullable().optional(),
    assessmentThresholdBand: band.optional(),
    acceptanceMaxMonths: z.number().int().min(1).max(12).optional(),
  });
export type SettingsInput = z.infer<typeof settingsSchema>;

const levelSchema = z.strictObject({
  axis: z.enum(['likelihood', 'impact']),
  level,
  label: name,
  descriptor: wording,
  // Likelihood only.
  frequency: wording,
});
export type LevelInput = z.infer<typeof levelSchema>;

const domainSchema = z.strictObject({
  // None: a new domain.
  id: z.uuid().optional(),
  name,
  // One per impact level, keyed "1" to the number of levels.
  descriptors: z
    .record(z.string().regex(/^[1-6]$/), wording)
    .transform(
      (all): RiskDomainDescriptors =>
        Object.fromEntries(
          Object.entries(all).filter(
            (e): e is [string, NonNullable<(typeof e)[1]>] => e[1] !== null,
          ),
        ),
    ),
  position: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});
export type DomainInput = z.infer<typeof domainSchema>;

const bandSchema = z.strictObject({
  code: band,
  name: name.optional(),
  reviewIntervalDays: z.number().int().min(1).max(730).optional(),
  escalateToCommitteeId: z.uuid().nullable().optional(),
  acceptanceNeedsSignature: z.boolean().optional(),
});
export type BandInput = z.infer<typeof bandSchema>;

const cellSchema = z.strictObject({ likelihood: level, impact: level, band });
export type CellInput = z.infer<typeof cellSchema>;

const size = z.number().int().min(3).max(6);

/**
 * A new draft version: a copy of another version, or a whole matrix of the
 * size wanted (every level, every cell, the four bands with every setting).
 */
export const matrixCreateSchema = z.union([
  z.strictObject({ copyOf: z.uuid() }),
  z.strictObject({
    likelihoodLevels: size,
    impactLevels: size,
    levels: z.array(levelSchema).min(6).max(12),
    domains: z.array(domainSchema.omit({ id: true })).min(1).max(12),
    bands: z
      .array(
        bandSchema.required({
          name: true,
          reviewIntervalDays: true,
          escalateToCommitteeId: true,
          acceptanceNeedsSignature: true,
        }),
      )
      .length(4),
    cells: z.array(cellSchema).min(9).max(36),
  }),
]);
export type MatrixCreateInput = z.infer<typeof matrixCreateSchema>;

/**
 * Changes to a version, part by part: what is not given stays. Levels by
 * axis and number, domains by id (none: added), bands by code, cells by
 * place. In use, only the wording changes (labels, descriptors,
 * frequencies, band names, domains); its size never does.
 */
export const matrixUpdateSchema = z.strictObject({
  revision,
  likelihoodLevels: size.optional(),
  impactLevels: size.optional(),
  levels: z.array(levelSchema).max(12).optional(),
  domains: z.array(domainSchema).max(12).optional(),
  bands: z.array(bandSchema).max(4).optional(),
  cells: z.array(cellSchema).max(36).optional(),
});
export type MatrixUpdateInput = z.infer<typeof matrixUpdateSchema>;

export const revisionOnly = z.strictObject({ revision });

export const categoryCreateSchema = z.strictObject({
  code,
  name,
  position: z.number().int().min(0).max(1000).default(0),
  appetite: z.enum(riskAppetite.enumValues),
  appetiteStatement: wording,
  toleranceBand: band,
});
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;

export const categoryUpdateSchema = z.strictObject({
  revision,
  name: name.optional(),
  position: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
  appetite: z.enum(riskAppetite.enumValues).optional(),
  appetiteStatement: wording.optional(),
  toleranceBand: band.optional(),
});
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

export const committeeCreateSchema = z.strictObject({
  code,
  name,
  position: z.number().int().min(0).max(1000).default(0),
  memberRoleId: z.uuid().nullable().default(null),
  chairRoleId: z.uuid().nullable().default(null),
});
export type CommitteeCreateInput = z.infer<typeof committeeCreateSchema>;

export const committeeUpdateSchema = z.strictObject({
  revision,
  name: name.optional(),
  position: z.number().int().min(0).max(1000).optional(),
  memberRoleId: z.uuid().nullable().optional(),
  chairRoleId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
});
export type CommitteeUpdateInput = z.infer<typeof committeeUpdateSchema>;

export const includeInactiveQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({ includeInactive: flag.default(false) }),
);

export const peopleQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({ q: line(1, 100).optional() }),
);

// The register.

/** A rating as a client gives it: the levels, and why. */
const ratingSchema = z.strictObject({
  likelihood: level,
  impact: level,
  rationale: wording,
});
export type RatingInput = z.infer<typeof ratingSchema>;

const keyword = line(1, 60);
const reference = line(1, 120);

const riskText = {
  title: localizedText(300),
  cause: requiredText(4000),
  event: requiredText(4000),
  consequence: requiredText(4000),
};

export const createSchema = z.strictObject({
  // Null: a risk of the whole organization.
  orgUnitId: z.uuid().nullable(),
  categoryId: z.uuid(),
  ...riskText,
  ownerId: z.uuid(),
  references: z.array(reference).max(30).default([]),
  keywords: z.array(keyword).max(30).default([]),
  treatment: z.enum(riskTreatment.enumValues).nullable().default(null),
  targetOn: day.nullable().default(null),
  // With it, the risk is opened; without it, proposed.
  current: ratingSchema.optional(),
  inherent: ratingSchema.optional(),
  target: ratingSchema.optional(),
  // "Raise a risk" from an incident the author sees in full (step 7): the
  // link is made with it. The incident's description is never copied.
  fromIncidentId: z.uuid().optional(),
  linkKind: z.enum(riskIncidentLinkKind.enumValues).default('raised'),
});
export type CreateInput = z.infer<typeof createSchema>;

export const updateSchema = z.strictObject({
  revision,
  // Required to change the owner, the unit or the category.
  reason: text(1, 1000).optional(),
  title: riskText.title.optional(),
  cause: riskText.cause.optional(),
  event: riskText.event.optional(),
  consequence: riskText.consequence.optional(),
  orgUnitId: z.uuid().nullable().optional(),
  categoryId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  references: z.array(reference).max(30).optional(),
  keywords: z.array(keyword).max(30).optional(),
  treatment: z.enum(riskTreatment.enumValues).nullable().optional(),
  targetOn: day.nullable().optional(),
});
export type UpdateInput = z.infer<typeof updateSchema>;

export const rateSchema = z.strictObject({
  revision,
  kind: z.enum(riskRatingKind.enumValues),
  ...ratingSchema.shape,
});
export type RateInput = z.infer<typeof rateSchema>;

export const acceptProposalSchema = z.strictObject({
  revision,
  ownerId: z.uuid(),
  current: ratingSchema,
  inherent: ratingSchema.optional(),
  target: ratingSchema.optional(),
});
export type AcceptProposalInput = z.infer<typeof acceptProposalSchema>;

export const rejectProposalSchema = z.strictObject({
  revision,
  reason: text(1, 1000),
});

const controlFields = {
  description: requiredText(2000),
  kind: z.enum(riskControlKind.enumValues),
  hierarchy: z.enum(riskControlHierarchy.enumValues).nullable(),
  ownerId: z.uuid(),
  effectiveness: z.enum(riskControlEffectiveness.enumValues),
  // None with an assessment: today.
  assessedOn: day.nullable(),
  documentId: z.uuid().nullable(),
};

export const controlCreateSchema = z.strictObject({
  // The risk's.
  revision,
  ...controlFields,
  hierarchy: controlFields.hierarchy.default(null),
  effectiveness: controlFields.effectiveness.default('not_assessed'),
  assessedOn: controlFields.assessedOn.default(null),
  documentId: controlFields.documentId.default(null),
});
export type ControlCreateInput = z.infer<typeof controlCreateSchema>;

export const controlUpdateSchema = z.strictObject({
  // The control's.
  revision,
  description: controlFields.description.optional(),
  kind: controlFields.kind.optional(),
  hierarchy: controlFields.hierarchy.optional(),
  ownerId: controlFields.ownerId.optional(),
  effectiveness: controlFields.effectiveness.optional(),
  assessedOn: controlFields.assessedOn.optional(),
  documentId: controlFields.documentId.optional(),
  active: z.boolean().optional(),
  // Required to switch a control off.
  reason: text(1, 1000).optional(),
});
export type ControlUpdateInput = z.infer<typeof controlUpdateSchema>;

export const listSchema = z.preprocess(
  blankAsUnset,
  z.strictObject({
    // Reference, title, cause, event, consequence and keywords, in any
    // language.
    q: line(1, 200).optional(),
    // With the units beneath it; `whole` for the risks of the whole
    // organization.
    unitId: z.union([z.uuid(), z.literal('whole')]).optional(),
    categoryId: z.uuid().optional(),
    // The current band.
    band: band.optional(),
    // None: open and proposed.
    status: z.enum(riskStatus.enumValues).optional(),
    ownerId: z.uuid().optional(),
    mine: flag.default(false),
    aboveTolerance: flag.default(false),
    notAddressed: flag.default(false),
    // `due`: the next review is within 30 days; `overdue`: it has passed.
    review: z.enum(['due', 'overdue']).optional(),
    committeeId: z.uuid().optional(),
    // The risks linked to an incident (step 7).
    incidentId: z.uuid().optional(),
    sort: z
      .enum(['score', 'next_review', 'reference', 'updated'])
      .default('score'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
);
export type ListInput = z.infer<typeof listSchema>;

// Reviews, escalation and corrections (steps 3 and 5).

export const reviewSchema = z.strictObject({
  revision,
  outcome: z.enum(riskReviewOutcome.enumValues),
  // Required: what was looked at and found.
  comment: text(1, 4000),
  // Confirmed or changed: a new rating row either way.
  current: ratingSchema,
  target: ratingSchema.optional(),
  // Controls whose effectiveness the review changed, assessed today.
  controls: z
    .array(
      z.strictObject({
        controlId: z.uuid(),
        effectiveness: z.enum(riskControlEffectiveness.enumValues),
      }),
    )
    .max(50)
    .default([]),
  treatment: z.enum(riskTreatment.enumValues).nullable().optional(),
  targetOn: day.nullable().optional(),
  // Earlier than the band's interval allows, never later.
  nextReviewOn: day.optional(),
  // For a committee's review: the committee the risk is escalated to.
  committeeId: z.uuid().optional(),
});
export type ReviewInput = z.infer<typeof reviewSchema>;

export const escalateSchema = z.strictObject({
  revision,
  committeeId: z.uuid(),
  reason: text(1, 1000),
});

export const deEscalateSchema = z.strictObject({
  revision,
  reason: text(1, 1000),
});

/**
 * A correction of text written once and kept (security review 15, M1, as
 * the business decided): a rating's rationale, a review's comment, the
 * reason a proposal was not taken or a control switched off. For a manager
 * of the risk; audited without the text.
 */
export const correctionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ revision, kind: z.literal('rating_rationale'), ratingId: z.uuid(), text: wording }),
  z.strictObject({ revision, kind: z.literal('review_comment'), reviewId: z.uuid(), text: text(1, 4000) }),
  z.strictObject({ revision, kind: z.literal('reject_reason'), text: text(1, 1000) }),
  z.strictObject({ revision, kind: z.literal('control_reason'), controlId: z.uuid(), text: text(1, 1000) }),
  // A reason kept as a note (security review 17, L5).
  z.strictObject({ revision, kind: z.literal('note'), noteId: z.uuid(), text: text(1, 4000) }),
  // The risk's own text, where it cannot otherwise be edited: a rejected
  // proposal, a closed risk (security review 17, L4).
  z.discriminatedUnion('field', [
    z.strictObject({ revision, kind: z.literal('risk_text'), field: z.literal('title'), text: localizedText(300) }),
    z.strictObject({
      revision,
      kind: z.literal('risk_text'),
      field: z.enum(['cause', 'event', 'consequence']),
      text: requiredText(4000),
    }),
  ]),
  // The reason a closure was asked for, or a risk closed.
  z.strictObject({ revision, kind: z.literal('close_reason'), text: text(1, 1000) }),
  // The note of a link to an incident, or why it was removed.
  z.strictObject({
    revision,
    kind: z.literal('link_text'),
    linkId: z.uuid(),
    field: z.enum(['note', 'removeReason']),
    text: text(1, 1000),
  }),
]);
export type CorrectionInput = z.infer<typeof correctionSchema>;

export const reviewsQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({
    state: z.enum(['due', 'overdue']).optional(),
    unitId: z.uuid().optional(),
  }),
);

/**
 * The correction of an action's text (security reviews 15 and 17): its
 * notes, its title and description, a reason kept as a note. For a manager
 * of its source.
 */
export const actionCorrectionSchema = z.discriminatedUnion('field', [
  z.strictObject({ revision, field: z.enum(['completionNote', 'verificationNote', 'cancelReason']), text: text(1, 4000) }),
  z.strictObject({ revision, field: z.literal('title'), text: localizedText(300) }),
  z.strictObject({ revision, field: z.literal('description'), text: requiredText(4000) }),
  z.strictObject({ revision, field: z.literal('note'), noteId: z.uuid(), text: text(1, 4000) }),
]);
export type ActionCorrectionInput = z.infer<typeof actionCorrectionSchema>;


// Approvals (step 6).

const password = z.string().min(1).max(1024);

export const acceptanceRequestSchema = z.strictObject({
  revision,
  // Why the risk is kept, in any of the client's languages; signed.
  rationale: requiredText(4000),
  // "While the second machine is on order".
  conditions: wording,
  // The last day, at most the client's longest acceptance ahead.
  until: day,
});
export type AcceptanceRequestInput = z.infer<typeof acceptanceRequestSchema>;

/** A signature: the password, or the signing PIN, again in this request. */
export const signedStepSchema = z.strictObject({
  revision,
  password,
  comment: text(1, 2000).optional(),
});

export const returnStepSchema = z.strictObject({ revision, comment: text(1, 2000) });

export const withdrawSchema = z.strictObject({ revision, reason: text(1, 1000) });

export const closeSchema = z.strictObject({
  revision,
  reason: text(1, 1000),
  // Merged into another risk, named by its id.
  mergedIntoId: z.uuid().optional(),
});

export const reopenSchema = z.strictObject({
  revision,
  reason: text(1, 1000),
  current: ratingSchema,
});

const routeStep = z
  .strictObject({
    kind: z.enum(['review', 'approve']),
    roleId: z.uuid().optional(),
    userId: z.uuid().optional(),
    dueInDays: z.number().int().min(1).max(365),
  })
  .refine((s) => !!s.roleId !== !!s.userId);

export const riskRouteCreateSchema = z
  .strictObject({
    subject: z.enum(['risk_acceptance', 'risk_closure']),
    // For an acceptance, the band it is for.
    variant: band.nullable().default(null),
    name,
    steps: z.array(routeStep).min(1).max(10),
  })
  .refine((r) => (r.subject === 'risk_acceptance') === (r.variant !== null) && r.variant !== 'low');
export type RiskRouteCreateInput = z.infer<typeof riskRouteCreateSchema>;

export const riskRouteUpdateSchema = z.strictObject({
  revision,
  name: name.optional(),
  steps: z.array(routeStep).min(1).max(10).optional(),
  active: z.boolean().optional(),
});
export type RiskRouteUpdateInput = z.infer<typeof riskRouteUpdateSchema>;

// Links (step 7).

export const incidentLinkSchema = z.strictObject({
  incidentId: z.uuid(),
  kind: z.enum(riskIncidentLinkKind.enumValues),
  note: text(1, 1000).optional(),
});

export const unlinkSchema = z.strictObject({ reason: text(1, 1000) });
