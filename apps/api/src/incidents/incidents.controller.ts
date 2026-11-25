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
import { optionalText, text } from '../i18n/text.js';
import { shiftDay, startOfDay } from '../i18n/time-zones.js';
import { IncidentsService } from './incidents.service.js';
import { MOVE_KINDS } from './status.js';
import { parseReport, reportSchema } from './report-input.js';

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

/** The revision of the incident the caller was looking at, if they say. */
const revision = z.number().int().min(1).optional();

// An empty value in the address (`?status=`) means the filter is not set.
const blankAsUnset = (query: unknown) =>
  query && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''))
    : query;

const listSchema = z.preprocess(
  blankAsUnset,
  z.strictObject({
    status: z.enum(incidentStatus.enumValues).optional(),
    type: z.enum(incidentType.enumValues).optional(),
    harmLevel: z.enum(incidentHarmLevel.enumValues).optional(),
    sentinel: flag.optional(),
    orgUnitId: z.uuid().optional(),
    // Days, both included, on the date of reporting: days on the hospital's
    // own calendar, whatever time zone the caller's browser is in.
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    // The start of a reference, or all of it: "inc-2026-0004". Digits alone
    // are also taken as the end of one: "42".
    reference: z
      .string()
      .trim()
      .max(20)
      .regex(/^[A-Za-z0-9-]+$/)
      .optional(),
    // What the summary counts as open, and as serious, so that each count
    // on the dashboard can link to exactly the incidents it counted.
    open: flag.default(false),
    serious: flag.default(false),
    // What the summary counts as overdue: past the deadline it is working
    // towards. Only among incidents the caller handles.
    overdue: flag.default(false),
    assignedToMe: flag.default(false),
    mine: flag.default(false),
    sort: z.enum(['newest', 'oldest', 'harm', 'due']).default('newest'),
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
  revision,
});

const statusSchema = z.strictObject({
  to: z.enum(incidentStatus.enumValues),
  // Which move is meant, as `moves` on the incident names it. Needed only
  // where two moves lead to the same status; checked whenever it is sent.
  kind: z.enum(MOVE_KINDS).optional(),
  note: optionalText(2000),
  revision,
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
    return this.incidents.report(req.auth, parseReport(reportSchema, body));
  }

  /**
   * Open to every signed-in user: the service returns only what they may
   * see, which for most staff is what they reported themselves.
   */
  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    const { from, to, ...filters } = parsed.data;
    const { timeZone } = req.auth.tenant;
    return this.incidents.list(req.auth, {
      ...filters,
      ...(from && { reportedFrom: startOfDay(from, timeZone) }),
      // Up to the end of the last day, which is where the next one starts.
      ...(to && { reportedBefore: startOfDay(shiftDay(to, 1), timeZone) }),
    });
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

  /**
   * No single permission opens this route, because the right depends on the
   * move: most need the right to triage, signing off a closure needs the
   * right to sign off, and whoever asked for a closure may withdraw it. The
   * service checks the right for the move asked for, on the incident itself,
   * before anything else about the incident can show in the answer.
   */
  @Post(':id/status')
  @HttpCode(200)
  changeStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const incidentId = this.parseId(id);
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { to, kind, note, revision } = parsed.data;
    return this.incidents.changeStatus(
      req.auth,
      incidentId,
      to,
      note,
      revision,
      kind,
    );
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
