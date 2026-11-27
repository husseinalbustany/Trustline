import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Database } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { pgErrorCode } from '../database/errors.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import { PLAN_FIELDS, PlansService } from '../subscriptions/plans.service.js';
import {
  createPlanSchema,
  updatePlanSchema,
} from '../subscriptions/subscription-input.js';
import {
  PlatformAuthGuard,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';

/**
 * The plans Trustline offers, for its own staff. Every change is written to
 * the platform audit log in the same transaction. There is no route that
 * deletes a plan: one is retired (`active: false`), and the clients on it
 * keep it.
 */
@Controller('platform/plans')
@UseGuards(PlatformAuthGuard)
@ForModule('core')
export class PlatformPlansController {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly plans: PlansService,
    private readonly auth: PlatformAuthService,
  ) {}

  @Get()
  list() {
    return this.plans.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.plans.get(this.parseId(id));
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = createPlanSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    try {
      return await this.db.transaction(async (tx) => {
        const plan = await this.plans.create(tx, parsed.data);
        await this.auth.audit(
          req.platformAdmin.id,
          'plan_created',
          null,
          { planId: plan.id, code: plan.code },
          tx,
        );
        return plan;
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') {
        throw new ConflictException({ code: 'code_taken' });
      }
      throw e;
    }
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const planId = this.parseId(id);
    const parsed = updatePlanSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new BadRequestException();
    }
    return this.db.transaction(async (tx) => {
      const { before, after } = await this.plans.update(
        tx,
        planId,
        parsed.data,
        req.platformAdmin,
      );
      const changes = Object.fromEntries(
        PLAN_FIELDS.filter(
          (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
        ).map((key) => [key, { from: before[key], to: after[key] }]),
      );
      await this.auth.audit(
        req.platformAdmin.id,
        'plan_updated',
        null,
        { planId, code: after.code, changes },
        tx,
      );
      return after;
    });
  }

  private parseId(id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return parsed.data;
  }
}
