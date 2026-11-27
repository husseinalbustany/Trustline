import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { orgUnitType } from '../database/schema.js';
import {
  requireEverywhere,
  SessionGuard,
  type AuthedRequest,
} from '../identity/session.guard.js';
import {
  fitsLanguages,
  localizedText,
  type Localized,
} from '../i18n/locales.js';
import { OrgUnitsService } from './org-units.service.js';
import { ForModule } from '../subscriptions/module.decorator.js';

const listSchema = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const createSchema = z.strictObject({
  type: z.enum(orgUnitType.enumValues),
  // Cannot be changed after creation.
  code: z.string().regex(/^[A-Z0-9-]{2,40}$/),
  name: localizedText(200),
  parentId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
});

// No `type` and no `code`: neither changes after creation.
const updateSchema = z
  .strictObject({
    name: localizedText(200),
    parentId: z.uuid().nullable(),
    active: z.boolean(),
  })
  .partial();

@Controller('org-units')
@UseGuards(SessionGuard)
@ForModule('core')
export class OrgUnitsController {
  constructor(private readonly orgUnits: OrgUnitsService) {}

  /**
   * The organization's facilities, departments and units. Open to every
   * signed-in user, because every form that picks a unit needs it; so it
   * holds the units that can be picked. The ones switched off are for whoever
   * manages the structure.
   *
   * The structure belongs to the hospital as a whole, and moving a unit
   * changes what every role granted for a department covers. So reading the
   * switched-off units and every write below need `organization.manage` for
   * the whole organization: holding it for one department is not enough.
   */
  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    const { includeInactive } = parsed.data;
    if (includeInactive) requireEverywhere(req, 'organization.manage');
    return this.orgUnits.list(req.auth, includeInactive);
  }

  @Post()
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'organization.manage');
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    this.assertLanguages(req, parsed.data.name);
    return this.orgUnits.create(req.auth, parsed.data);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'organization.manage');
    const unitId = z.uuid().safeParse(id);
    if (!unitId.success) throw new NotFoundException();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new BadRequestException();
    }
    this.assertLanguages(req, parsed.data.name);
    return this.orgUnits.update(req.auth, unitId.data, parsed.data);
  }

  /** A unit is named in the client's default language, in its languages only. */
  private assertLanguages(req: AuthedRequest, name?: Localized) {
    if (name && !fitsLanguages(name, req.auth.tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
  }
}
