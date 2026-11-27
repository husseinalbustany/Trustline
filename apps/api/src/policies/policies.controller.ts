import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  requireEverywhere,
  requirePermission,
  SessionGuard,
  type AuthedRequest,
} from '../identity/session.guard.js';
import type { Permission } from '../identity/permissions.js';
import {
  ForModule,
  OpenWhileSuspended,
} from '../subscriptions/module.decorator.js';
import { CSV_CONTENT_TYPE } from './csv.js';
import { DocumentsService } from './documents.service.js';
import {
  acknowledgeSchema,
  acknowledgementExportQuery,
  acknowledgementsQuery,
  approveSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  changesQuery,
  createSchema,
  documentExportQuery,
  editVersionSchema,
  listSchema,
  overdueQuery,
  parse,
  parseId,
  peopleQuery,
  publishSchema,
  retireSchema,
  returnSchema,
  reviewSchema,
  revisionOnly,
  routeCreateSchema,
  routeUpdateSchema,
  settingsSchema,
  typeCreateSchema,
  typeUpdateSchema,
  updateSchema,
  withdrawSchema,
} from './input.js';
import { LibraryService } from './library.service.js';
import { PolicySettingsService } from './settings.service.js';
import { z } from 'zod';

/** Any of the module's permissions: who may use the library at all. */
const ANY_POLICIES: Permission[] = [
  'policies.view',
  'policies.manage',
  'policies.view_all',
  'policies.approve',
];

/** What reads documents: `policies.view`, or what includes reading them. */
const READS: Permission[] = [
  'policies.view',
  'policies.manage',
  'policies.view_all',
];

/**
 * Refuses unless the user holds one of these somewhere. Answered as for the
 * first of them, which is the one a screen would offer.
 */
function requireAnyOf(req: AuthedRequest, permissions: Permission[]) {
  if (!permissions.some((p) => req.auth.permissions.includes(p))) {
    throw new ForbiddenException({
      code: 'missing_permission',
      permission: permissions[0],
    });
  }
}

/** What sees acknowledgement figures: full sight of some documents. */
const FIGURES: Permission[] = ['policies.view_all', 'policies.manage'];

/**
 * Sends a file made by a service as a download: never cached, since it is
 * evidence of one moment, and named for what it is and the client's day.
 */
function sendCsv(res: Response, file: { body: string; fileName: string }) {
  res.setHeader('Content-Type', CSV_CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.fileName}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  return file.body;
}

const includeInactiveQuery = z.preprocess(
  (q) =>
    q && typeof q === 'object'
      ? Object.fromEntries(Object.entries(q).filter(([, v]) => v !== ''))
      : q,
  z.strictObject({
    includeInactive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default(false),
  }),
);

/**
 * The library of controlled documents: documents, their versions, their
 * approval, publishing, acknowledgement and periodic review, and what
 * awaits the caller. All of it is the `policies` module.
 *
 * While the subscription is suspended, everything here is read-only
 * (SessionGuard) except acknowledging a document, publishing an approved
 * version and retiring a document, which stay open: they are safety work
 * (reading and confirming what applies to oneself; putting a corrected
 * document that is already approved in force; taking an unsafe one away
 * from readers), and a billing matter never blocks safety work.
 */
@Controller('policies')
@UseGuards(SessionGuard)
@ForModule('policies')
export class PoliciesController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly library: LibraryService,
  ) {}

  @Get('documents')
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    return this.library.list(req.auth, parse(listSchema, query));
  }

  @Post('documents')
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'policies.manage');
    return this.documents.create(req.auth, parse(createSchema, body));
  }

  // Declared before 'documents/:id' as a habit; these have paths of their
  // own anyway.
  @Get('summary')
  summary(@Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    return this.library.summary(req.auth);
  }

  @Get('approvals')
  approvals(@Req() req: AuthedRequest) {
    requirePermission(req, 'policies.approve');
    return this.library.myApprovals(req.auth);
  }

  @Get('reviews')
  reviews(@Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    return this.library.reviewsDue(req.auth);
  }

  @Get('people')
  people(@Query() query: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'policies.manage');
    return this.library.people(req.auth, parse(peopleQuery, query));
  }

  /**
   * The master list of documents as a CSV file: the library as the caller
   * sees it, with its filters, every page, in the caller's language.
   */
  @Get('exports/documents')
  async exportDocuments(
    @Query() query: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    requireAnyOf(req, ANY_POLICIES);
    const input = parse(documentExportQuery, query);
    return sendCsv(res, await this.library.exportDocuments(req.auth, input));
  }

  /**
   * Acknowledgements overdue among the people whose figures the caller
   * sees: where the weekly digest leads.
   */
  @Get('acknowledgements/overdue')
  overdue(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireAnyOf(req, FIGURES);
    return this.library.overdueAcknowledgements(
      req.auth,
      parse(overdueQuery, query),
    );
  }

  @Get('documents/:id')
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    return this.documents.get(req.auth, parseId(id));
  }

  @Patch('documents/:id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const documentId = parseId(id);
    return this.documents.update(req.auth, documentId, parse(updateSchema, body));
  }

  /** Open while the subscription is suspended: see the class. */
  @Post('documents/:id/retire')
  @HttpCode(200)
  @OpenWhileSuspended()
  retire(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const documentId = parseId(id);
    return this.documents.retire(req.auth, documentId, parse(retireSchema, body));
  }

  /**
   * The periodic review, confirmed with no change. No single permission
   * opens it: the document's owner may, as may a manager of it. The service
   * checks which on the document itself.
   */
  @Post('documents/:id/review')
  @HttpCode(200)
  review(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireAnyOf(req, ANY_POLICIES);
    const documentId = parseId(id);
    return this.documents.confirmReview(
      req.auth,
      documentId,
      parse(reviewSchema, body),
      req.ip ?? null,
    );
  }

  @Get('documents/:id/versions')
  history(@Param('id') id: string, @Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    return this.documents.history(req.auth, parseId(id));
  }

  /** The history of a document's details: for those with full sight. */
  @Get('documents/:id/changes')
  changes(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireAnyOf(req, FIGURES);
    const documentId = parseId(id);
    return this.documents.changes(
      req.auth,
      documentId,
      parse(changesQuery, query),
    );
  }

  @Post('documents/:id/versions')
  createVersion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const documentId = parseId(id);
    parse(z.strictObject({}), body ?? {});
    return this.documents.createVersion(req.auth, documentId);
  }

  @Get('documents/:id/versions/:versionId')
  version(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Req() req: AuthedRequest,
  ) {
    requireAnyOf(req, ANY_POLICIES);
    return this.documents.getVersion(req.auth, parseId(id), parseId(versionId));
  }

  @Patch('documents/:id/versions/:versionId')
  editVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const [doc, version] = [parseId(id), parseId(versionId)];
    return this.documents.editVersion(
      req.auth,
      doc,
      version,
      parse(editVersionSchema, body),
    );
  }

  @Post('documents/:id/versions/:versionId/submit')
  @HttpCode(200)
  submit(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const [doc, version] = [parseId(id), parseId(versionId)];
    const { revision } = parse(revisionOnly, body);
    return this.documents.submit(req.auth, doc, version, revision);
  }

  @Post('documents/:id/versions/:versionId/approve')
  @HttpCode(200)
  approve(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.approve');
    const [doc, version] = [parseId(id), parseId(versionId)];
    return this.documents.approve(
      req.auth,
      doc,
      version,
      parse(approveSchema, body),
      req.ip ?? null,
    );
  }

  @Post('documents/:id/versions/:versionId/return')
  @HttpCode(200)
  returnVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.approve');
    const [doc, version] = [parseId(id), parseId(versionId)];
    return this.documents.returnVersion(
      req.auth,
      doc,
      version,
      parse(returnSchema, body),
    );
  }

  @Post('documents/:id/versions/:versionId/recall')
  @HttpCode(200)
  recall(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const [doc, version] = [parseId(id), parseId(versionId)];
    const { revision } = parse(revisionOnly, body);
    return this.documents.recall(req.auth, doc, version, revision);
  }

  @Post('documents/:id/versions/:versionId/withdraw')
  @HttpCode(200)
  withdraw(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const [doc, version] = [parseId(id), parseId(versionId)];
    return this.documents.withdraw(
      req.auth,
      doc,
      version,
      parse(withdrawSchema, body),
    );
  }

  /** Open while the subscription is suspended: see the class. */
  @Post('documents/:id/versions/:versionId/publish')
  @HttpCode(200)
  @OpenWhileSuspended()
  publish(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'policies.manage');
    const [doc, version] = [parseId(id), parseId(versionId)];
    return this.documents.publish(
      req.auth,
      doc,
      version,
      parse(publishSchema, body),
    );
  }

  /** Open while the subscription is suspended: see the class. */
  @Post('documents/:id/versions/:versionId/acknowledge')
  @HttpCode(200)
  @OpenWhileSuspended()
  acknowledge(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireAnyOf(req, READS);
    const [doc, version] = [parseId(id), parseId(versionId)];
    const { password } = parse(acknowledgeSchema, body);
    return this.documents.acknowledge(
      req.auth,
      doc,
      version,
      password,
      req.ip ?? null,
    );
  }

  @Get('documents/:id/versions/:versionId/acknowledgements')
  acknowledgements(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Query() query: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireAnyOf(req, FIGURES);
    const [doc, version] = [parseId(id), parseId(versionId)];
    return this.library.acknowledgements(
      req.auth,
      doc,
      version,
      parse(acknowledgementsQuery, query),
    );
  }

  /** The same as a CSV file, everyone asked, those who left included. */
  @Get('documents/:id/versions/:versionId/acknowledgements/export')
  async exportAcknowledgements(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Query() query: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    requireAnyOf(req, FIGURES);
    const [doc, version] = [parseId(id), parseId(versionId)];
    const input = parse(acknowledgementExportQuery, query);
    return sendCsv(
      res,
      await this.library.exportAcknowledgements(req.auth, doc, version, input),
    );
  }
}

/**
 * The settings of the policies module: document types, categories and
 * approval routes. Read by anyone who uses the module (routes: by those who
 * manage documents); changed only by those who manage documents for the
 * whole organization, since they belong to all of it.
 */
@Controller('policies')
@UseGuards(SessionGuard)
@ForModule('policies')
export class PolicySettingsController {
  constructor(private readonly settings: PolicySettingsService) {}

  @Get('types')
  types(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    const { includeInactive } = parse(includeInactiveQuery, query);
    if (includeInactive) requirePermission(req, 'policies.manage');
    return this.settings.types(req.auth, includeInactive);
  }

  @Post('types')
  createType(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'policies.manage');
    return this.settings.createType(req.auth, parse(typeCreateSchema, body));
  }

  @Patch('types/:id')
  updateType(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'policies.manage');
    const typeId = parseId(id);
    return this.settings.updateType(req.auth, typeId, parse(typeUpdateSchema, body));
  }

  @Get('categories')
  categories(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    const { includeInactive } = parse(includeInactiveQuery, query);
    if (includeInactive) requirePermission(req, 'policies.manage');
    return this.settings.categories(req.auth, includeInactive);
  }

  @Post('categories')
  createCategory(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'policies.manage');
    return this.settings.createCategory(
      req.auth,
      parse(categoryCreateSchema, body),
    );
  }

  @Patch('categories/:id')
  updateCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'policies.manage');
    const categoryId = parseId(id);
    return this.settings.updateCategory(
      req.auth,
      categoryId,
      parse(categoryUpdateSchema, body),
    );
  }

  /**
   * The client's roles by name, for whoever manages documents: to narrow an
   * audience or name a role in a step, without managing users or roles.
   */
  @Get('roles')
  roles(@Req() req: AuthedRequest) {
    requirePermission(req, 'policies.manage');
    return this.settings.roles(req.auth);
  }

  /** The module's settings: the longest review period a document may have. */
  @Get('settings')
  getSettings(@Req() req: AuthedRequest) {
    requireAnyOf(req, ANY_POLICIES);
    return this.settings.settings(req.auth);
  }

  @Patch('settings')
  updateSettings(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'policies.manage');
    return this.settings.updateSettings(req.auth, parse(settingsSchema, body));
  }

  @Get('approval-routes')
  routes(@Req() req: AuthedRequest) {
    requirePermission(req, 'policies.manage');
    return this.settings.routes(req.auth);
  }

  @Post('approval-routes')
  createRoute(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'policies.manage');
    return this.settings.createRoute(req.auth, parse(routeCreateSchema, body));
  }

  @Patch('approval-routes/:id')
  updateRoute(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'policies.manage');
    const routeId = parseId(id);
    return this.settings.updateRoute(
      req.auth,
      routeId,
      parse(routeUpdateSchema, body),
    );
  }
}
