import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  incidentCommentVisibility,
  incidentHarmLevel,
  incidentStatus,
  incidentType,
} from '../database/schema.js';
import {
  requirePermission,
  SessionGuard,
  type AuthedRequest,
} from '../identity/session.guard.js';
import {
  CLOCK_TOLERANCE_MINUTES,
  IncidentsService,
} from './incidents.service.js';

/** Free text: trimmed, within its limits, and storable (no NUL character). */
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !v.includes('\u0000'));

const optionalText = (max: number) =>
  text(0, max)
    .nullish()
    .transform((v) => v || null);

const reportSchema = z.strictObject({
  type: z.enum(incidentType.enumValues),
  categoryId: z.uuid(),
  orgUnitId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  description: text(1, 5000),
  immediateAction: optionalText(2000),
  harmLevel: z.enum(incidentHarmLevel.enumValues),
  anonymous: z.boolean(),
});

// An empty value in the address (`?status=`) means the filter is not set.
const blankAsUnset = (query: unknown) =>
  query && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''))
    : query;

const listSchema = z.preprocess(
  blankAsUnset,
  z.strictObject({
    status: z.enum(incidentStatus.enumValues).optional(),
    mine: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
);

const triageSchema = z.strictObject({
  harmLevel: z.enum(incidentHarmLevel.enumValues),
  isSentinel: z.boolean(),
  categoryId: z.uuid().optional(),
  ownerUnitId: z.uuid(),
  assignedTo: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
});

const statusSchema = z.strictObject({
  to: z.enum(incidentStatus.enumValues),
  note: optionalText(2000),
});

const commentSchema = z.strictObject({
  body: text(1, 2000),
  visibility: z.enum(incidentCommentVisibility.enumValues),
});

@Controller('incident-categories')
@UseGuards(SessionGuard)
export class IncidentCategoriesController {
  constructor(private readonly incidents: IncidentsService) {}

  /** The categories a report can be filed under, in display order. */
  @Get()
  list(@Req() req: AuthedRequest) {
    return this.incidents.categories(req.auth);
  }
}

@Controller('incidents')
@UseGuards(SessionGuard)
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post()
  report(@Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'incidents.report');
    const parsed = reportSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const latest = Date.now() + CLOCK_TOLERANCE_MINUTES * 60_000;
    if (parsed.data.occurredAt.getTime() > latest) {
      throw new BadRequestException({ code: 'occurred_in_future' });
    }
    return this.incidents.report(req.auth, parsed.data);
  }

  /**
   * Open to every signed-in user: the service returns only what they may
   * see, which for most staff is what they reported themselves.
   */
  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    return this.incidents.list(req.auth, parsed.data);
  }

  // Declared before ':id', or Nest would take "summary" for an id.
  @Get('summary')
  summary(@Req() req: AuthedRequest) {
    return this.incidents.summary(req.auth);
  }

  // Also before ':id'. For the triage panel, so it asks for the right to
  // triage, not the right to manage users.
  @Get('assignable-users')
  assignableUsers(@Req() req: AuthedRequest) {
    requirePermission(req, 'incidents.triage');
    return this.incidents.assignableUsers(req.auth);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.incidents.get(req.auth, this.parseId(id));
  }

  @Post(':id/triage')
  @HttpCode(200)
  triage(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'incidents.triage');
    const incidentId = this.parseId(id);
    const parsed = triageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.incidents.triage(req.auth, incidentId, parsed.data);
  }

  @Post(':id/status')
  @HttpCode(200)
  changeStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'incidents.triage');
    const incidentId = this.parseId(id);
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { to, note } = parsed.data;
    return this.incidents.changeStatus(req.auth, incidentId, to, note);
  }

  /** Anyone who may see the incident may comment on it. */
  @Post(':id/comments')
  comment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const incidentId = this.parseId(id);
    const parsed = commentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.incidents.comment(req.auth, incidentId, parsed.data);
  }

  private parseId(id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return parsed.data;
  }
}
