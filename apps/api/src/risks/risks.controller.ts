import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  requireEverywhere,
  requirePermission,
  SessionGuard,
  whileSuspended,
  type AuthedRequest,
} from '../identity/session.guard.js';
import {
  ForModule,
  OpenWhileSuspended,
} from '../subscriptions/module.decorator.js';
import {
  completeActionSchema,
  createActionSchema,
  reasonSchema,
  updateActionSchema,
  verifyActionSchema,
} from '../actions/input.js';
import {
  acceptanceRequestSchema,
  acceptProposalSchema,
  actionCorrectionSchema,
  closeSchema,
  incidentLinkSchema,
  reopenSchema,
  returnStepSchema,
  riskRouteCreateSchema,
  riskRouteUpdateSchema,
  signedStepSchema,
  unlinkSchema,
  withdrawSchema,
  correctionSchema,
  deEscalateSchema,
  escalateSchema,
  reviewSchema,
  reviewsQuery,
  categoryCreateSchema,
  categoryUpdateSchema,
  committeeCreateSchema,
  committeeUpdateSchema,
  controlCreateSchema,
  controlUpdateSchema,
  createSchema,
  includeInactiveQuery,
  listSchema,
  matrixCreateSchema,
  matrixUpdateSchema,
  parse,
  parseId,
  peopleQuery,
  rateSchema,
  rejectProposalSchema,
  revisionOnly,
  settingsSchema,
  updateSchema,
} from './input.js';
import { RiskApprovalsService } from './approvals.service.js';
import { RiskLinksService } from './links.service.js';
import { RiskRegisterService } from './register.service.js';
import { RiskSettingsService } from './settings.service.js';
import { RiskWorkService } from './work.service.js';

/**
 * The settings of the risks module (docs/specs/risk-management.md, step
 * 1): the matrix and its versions, categories with appetite and tolerance,
 * committees, and the module's few settings. They are the organization's
 * risk criteria: read by anyone signed in with the module, since whoever
 * rates or writes a risk needs them (an owner may hold no permission of the
 * module); changed only by those who manage risks for the whole
 * organization. Declared before the register's controller, so that these
 * paths are never read as a risk's id.
 */
@Controller('risks')
@UseGuards(SessionGuard)
@ForModule('risks')
export class RiskSettingsController {
  constructor(
    private readonly settings: RiskSettingsService,
    private readonly approvals: RiskApprovalsService,
  ) {}

  @Get('settings')
  getSettings(@Req() req: AuthedRequest) {
    return this.settings.settings(req.auth);
  }

  @Patch('settings')
  updateSettings(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'risks.manage');
    return this.settings.updateSettings(req.auth, parse(settingsSchema, body));
  }

  @Get('settings/matrices')
  matrices(@Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    return this.settings.matrices(req.auth);
  }

  @Get('settings/matrices/:id')
  matrix(@Param('id') id: string, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    return this.settings.matrix(req.auth, parseId(id));
  }

  @Post('settings/matrices')
  createMatrix(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'risks.manage');
    return this.settings.createMatrix(req.auth, parse(matrixCreateSchema, body));
  }

  @Patch('settings/matrices/:id')
  updateMatrix(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'risks.manage');
    const input = parse(matrixUpdateSchema, body);
    return this.settings.updateMatrix(req.auth, parseId(id), input);
  }

  @Post('settings/matrices/:id/put-in-use')
  @HttpCode(200)
  putInUse(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'risks.manage');
    const { revision } = parse(revisionOnly, body);
    return this.settings.putInUse(req.auth, parseId(id), revision);
  }

  @Post('settings/matrices/:id/discard')
  @HttpCode(200)
  discard(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'risks.manage');
    const { revision } = parse(revisionOnly, body);
    return this.settings.discard(req.auth, parseId(id), revision);
  }

  @Get('settings/categories')
  categories(@Query() query: unknown, @Req() req: AuthedRequest) {
    const { includeInactive } = parse(includeInactiveQuery, query);
    if (includeInactive) requirePermission(req, 'risks.manage');
    return this.settings.categories(req.auth, includeInactive);
  }

  @Post('settings/categories')
  createCategory(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'risks.manage');
    return this.settings.createCategory(req.auth, parse(categoryCreateSchema, body));
  }

  @Patch('settings/categories/:id')
  updateCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'risks.manage');
    const input = parse(categoryUpdateSchema, body);
    return this.settings.updateCategory(req.auth, parseId(id), input);
  }

  @Get('settings/committees')
  committees(@Query() query: unknown, @Req() req: AuthedRequest) {
    const { includeInactive } = parse(includeInactiveQuery, query);
    if (includeInactive) requirePermission(req, 'risks.manage');
    return this.settings.committees(req.auth, includeInactive);
  }

  @Post('settings/committees')
  createCommittee(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'risks.manage');
    return this.settings.createCommittee(req.auth, parse(committeeCreateSchema, body));
  }

  @Patch('settings/committees/:id')
  updateCommittee(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'risks.manage');
    const input = parse(committeeUpdateSchema, body);
    return this.settings.updateCommittee(req.auth, parseId(id), input);
  }

  /** The acceptance and closure routes (step 6). */
  @Get('settings/approval-routes')
  approvalRoutes(@Req() req: AuthedRequest) {
    requireEverywhere(req, 'risks.manage');
    return this.approvals.routes(req.auth);
  }

  @Post('settings/approval-routes')
  createApprovalRoute(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'risks.manage');
    return this.approvals.createRoute(req.auth, parse(riskRouteCreateSchema, body));
  }

  @Patch('settings/approval-routes/:id')
  updateApprovalRoute(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'risks.manage');
    const input = parse(riskRouteUpdateSchema, body);
    return this.approvals.updateRoute(req.auth, parseId(id), input);
  }

  /** The client's roles by name, to name a committee's members. */
  @Get('roles')
  roles(@Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    return this.settings.roles(req.auth);
  }

  /** Active people by name, to name an owner. */
  @Get('people')
  people(@Query() query: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    return this.settings.people(req.auth, parse(peopleQuery, query).q);
  }
}

/**
 * The risk register (docs/specs/risk-management.md, step 2): the list, a
 * risk's page, creating and editing risks, rating them, their controls,
 * and taking proposals onto the register. Who reads a risk is not only a
 * matter of permissions (its owner and the members of the committee it is
 * escalated to read it too), so reading routes are filtered by
 * `visibility.ts` rather than refused; a risk out of reach is 404. Routes
 * that only a manager uses check `risks.manage` first; the others check,
 * on the risk, that the caller is its owner or a manager.
 *
 * While the subscription is suspended, everything here is read-only except
 * recording a current rating (business decision 16).
 */
@Controller('risks')
@UseGuards(SessionGuard)
@ForModule('risks')
export class RisksController {
  constructor(
    private readonly register: RiskRegisterService,
    private readonly work: RiskWorkService,
    private readonly approvals: RiskApprovalsService,
    private readonly links: RiskLinksService,
  ) {}

  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    return this.register.list(req.auth, parse(listSchema, query));
  }

  /**
   * A new risk, for a manager; or "Raise a risk" from an incident
   * (`fromIncidentId`), for anyone who sees the incident in full, which
   * the service checks. Raising from an incident is open while suspended,
   * as a proposal only.
   */
  @Post()
  @OpenWhileSuspended()
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(createSchema, body);
    if (!input.fromIncidentId) requirePermission(req, 'risks.manage');
    await whileSuspended(req, () => !!input.fromIncidentId);
    return this.register.create(req.auth, input);
  }

  @Get(':id')
  detail(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.register.detail(req.auth, parseId(id));
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'risks.manage');
    const input = parse(updateSchema, body);
    return this.register.update(req.auth, parseId(id), input);
  }

  @Post(':id/ratings')
  @HttpCode(200)
  @OpenWhileSuspended()
  async rate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const input = parse(rateSchema, body);
    const riskId = parseId(id);
    await whileSuspended(req, () => input.kind === 'current');
    return this.register.rate(req.auth, riskId, input);
  }

  @Post(':id/controls')
  addControl(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const input = parse(controlCreateSchema, body);
    return this.register.addControl(req.auth, parseId(id), input);
  }

  @Patch(':id/controls/:controlId')
  updateControl(
    @Param('id') id: string,
    @Param('controlId') controlId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const input = parse(controlUpdateSchema, body);
    return this.register.updateControl(req.auth, parseId(id), parseId(controlId), input);
  }

  @Post(':id/proposal/accept')
  @HttpCode(200)
  acceptProposal(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'risks.manage');
    const input = parse(acceptProposalSchema, body);
    return this.register.acceptProposal(req.auth, parseId(id), input);
  }

  @Post(':id/proposal/reject')
  @HttpCode(200)
  rejectProposal(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'risks.manage');
    const input = parse(rejectProposalSchema, body);
    return this.register.rejectProposal(req.auth, parseId(id), input);
  }

  /**
   * Corrects a rationale, a comment or a reason written on the risk (a
   * manager of it): audited without the text (security review 15, M1).
   */
  @Post(':id/corrections')
  @HttpCode(200)
  correct(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    const input = parse(correctionSchema, body);
    return this.register.correct(req.auth, parseId(id), input);
  }

  /** A review: by its owner, a manager, or a member of its committee. */
  @Post(':id/reviews')
  @HttpCode(200)
  review(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(reviewSchema, body);
    return this.work.review(req.auth, parseId(id), input);
  }

  /** Escalation by hand: safety work, open while suspended. */
  @Post(':id/escalate')
  @HttpCode(200)
  @OpenWhileSuspended()
  escalate(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    const input = parse(escalateSchema, body);
    return this.work.escalate(req.auth, parseId(id), input);
  }

  /** For a member of its committee, or a manager for the whole organization. */
  @Post(':id/de-escalate')
  @HttpCode(200)
  deEscalate(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(deEscalateSchema, body);
    return this.work.deEscalate(req.auth, parseId(id), input);
  }

  // Acceptance above tolerance (step 6).

  /** For its owner or a manager of it. */
  @Post(':id/acceptance')
  @HttpCode(200)
  requestAcceptance(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(acceptanceRequestSchema, body);
    return this.approvals.requestAcceptance(req.auth, parseId(id), input);
  }

  /** A signature: the password, or the signing PIN, again. */
  @Post(':id/acceptance/approve')
  @HttpCode(200)
  approveAcceptance(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.approve');
    const input = parse(signedStepSchema, body);
    return this.approvals.approveAcceptance(req.auth, parseId(id), input, req.ip ?? null);
  }

  @Post(':id/acceptance/return')
  @HttpCode(200)
  returnAcceptance(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.approve');
    const input = parse(returnStepSchema, body);
    return this.approvals.returnAcceptance(req.auth, parseId(id), input);
  }

  /** For its requester or a manager of the risk. */
  @Post(':id/acceptance/withdraw')
  @HttpCode(200)
  withdrawAcceptance(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(withdrawSchema, body);
    return this.approvals.withdrawAcceptance(req.auth, parseId(id), input);
  }

  // Closing and reopening (step 6).

  @Post(':id/close')
  @HttpCode(200)
  close(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    const input = parse(closeSchema, body);
    return this.approvals.close(req.auth, parseId(id), input);
  }

  @Post(':id/closure/approve')
  @HttpCode(200)
  approveClosure(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.approve');
    const input = parse(signedStepSchema, body);
    return this.approvals.approveClosure(req.auth, parseId(id), input, req.ip ?? null);
  }

  @Post(':id/closure/return')
  @HttpCode(200)
  returnClosure(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.approve');
    const input = parse(returnStepSchema, body);
    return this.approvals.returnClosure(req.auth, parseId(id), input);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    const input = parse(reopenSchema, body);
    return this.approvals.reopen(req.auth, parseId(id), input);
  }

  // Links to incidents (step 7).

  /** For a manager of the risk who sees the incident in full. */
  @Post(':id/incident-links')
  linkIncident(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    const input = parse(incidentLinkSchema, body);
    return this.links.link(req.auth, parseId(id), input);
  }

  @Delete(':id/incident-links/:linkId')
  @HttpCode(204)
  async unlinkIncident(
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'risks.manage');
    const input = parse(unlinkSchema, body);
    await this.links.unlink(req.auth, parseId(id), parseId(linkId), input);
  }

  @Get(':id/actions')
  listActions(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.work.listActions(req.auth, parseId(id));
  }

  /** For its owner or a manager. */
  @Post(':id/actions')
  addAction(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(createActionSchema, body);
    return this.work.addAction(req.auth, parseId(id), input);
  }
}

/**
 * What gathers work on risks (steps 3 to 5): "My risks and actions",
 * "Reviews due", the dashboard's counts, a committee's list, and the
 * actions on risks, through the shared engine (docs/specs/actions.md).
 * Declared before the register's controller, so that these paths are never
 * read as a risk's id. Reading answers are filtered by `visibility.ts`;
 * "Reviews due" is for managers.
 */
@Controller('risks')
@UseGuards(SessionGuard)
@ForModule('risks')
export class RiskWorkController {
  constructor(
    private readonly work: RiskWorkService,
    private readonly approvals: RiskApprovalsService,
    private readonly links: RiskLinksService,
  ) {}

  /** The acceptance and closure steps waiting for the caller's signature. */
  @Get('approvals')
  myApprovals(@Req() req: AuthedRequest) {
    requirePermission(req, 'risks.approve');
    return this.approvals.myApprovals(req.auth);
  }

  /** The incident's panel: for whoever sees the incident (step 7). */
  @Get('for-incident/:incidentId')
  forIncident(@Param('incidentId') incidentId: string, @Req() req: AuthedRequest) {
    return this.links.forIncident(req.auth, parseId(incidentId));
  }

  /** The document's panel: for whoever may read the document (step 7). */
  @Get('for-document/:documentId')
  forDocument(@Param('documentId') documentId: string, @Req() req: AuthedRequest) {
    return this.links.forDocument(req.auth, parseId(documentId));
  }

  @Get('mine')
  mine(@Req() req: AuthedRequest) {
    return this.work.mine(req.auth);
  }

  @Get('reviews')
  reviews(@Query() query: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'risks.manage');
    return this.work.reviewsDue(req.auth, parse(reviewsQuery, query));
  }

  @Get('summary')
  summary(@Req() req: AuthedRequest) {
    return this.work.summary(req.auth);
  }

  @Get('committees/:id/risks')
  committeeRisks(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.work.committeeRisks(req.auth, parseId(id));
  }

  @Get('actions/:actionId')
  action(@Param('actionId') actionId: string, @Req() req: AuthedRequest) {
    return this.work.action(req.auth, parseId(actionId));
  }

  /** For its owner (progress, due day) or a manager of its risk. */
  @Patch('actions/:actionId')
  updateAction(@Param('actionId') actionId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(updateActionSchema, body);
    return this.work.updateAction(req.auth, parseId(actionId), input);
  }

  /** Safety work: open while suspended (business decision 16). */
  @Post('actions/:actionId/complete')
  @HttpCode(200)
  @OpenWhileSuspended()
  completeAction(@Param('actionId') actionId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(completeActionSchema, body);
    return this.work.completeAction(req.auth, parseId(actionId), input);
  }

  @Post('actions/:actionId/verify')
  @HttpCode(200)
  verifyAction(@Param('actionId') actionId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(verifyActionSchema, body);
    return this.work.verifyAction(req.auth, parseId(actionId), input);
  }

  @Post('actions/:actionId/cancel')
  @HttpCode(200)
  cancelAction(@Param('actionId') actionId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(reasonSchema, body);
    return this.work.cancelAction(req.auth, parseId(actionId), input);
  }

  @Post('actions/:actionId/reopen')
  @HttpCode(200)
  reopenAction(@Param('actionId') actionId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(reasonSchema, body);
    return this.work.reopenAction(req.auth, parseId(actionId), input);
  }

  /** A manager of its risk corrects a note (M1), audited without the text. */
  @Post('actions/:actionId/corrections')
  @HttpCode(200)
  correctAction(@Param('actionId') actionId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(actionCorrectionSchema, body);
    return this.work.correctAction(req.auth, parseId(actionId), input);
  }
}
