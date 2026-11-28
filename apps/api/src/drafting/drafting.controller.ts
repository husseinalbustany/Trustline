import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  requireEverywhere,
  requirePermission,
  SessionGuard,
  type AuthedRequest,
} from '../identity/session.guard.js';
import { parse, parseId } from '../policies/input.js';
import { ForModule, noSuchRoute } from '../subscriptions/module.decorator.js';
import { putDesignSchema } from './design-input.js';
import { DesignService } from './design.service.js';
import {
  answerSchema,
  designQuery,
  editSchema,
  handOverSchema,
  reviseSchema,
  startSchema,
} from './drafting-input.js';
import { DraftingService } from './drafting.service.js';
import { putProfileSchema } from './profile-input.js';
import { ProfileService } from './profile.service.js';

/**
 * The client profile (docs/specs/ai-policy-drafting.md): core, since it is
 * the organization's standing description whatever modules it has. For
 * those who manage the settings of the whole organization.
 */
@Controller('settings')
@UseGuards(SessionGuard)
@ForModule('core')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get('profile')
  get(@Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    return this.profiles.get(req.auth);
  }

  @Put('profile')
  put(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    return this.profiles.put(req.auth, parse(putProfileSchema, body));
  }
}

/**
 * The document design, part of the policies module: it is applied to
 * documents written by hand as well. For those who manage the settings of
 * the whole organization.
 */
@Controller('policies')
@UseGuards(SessionGuard)
@ForModule('policies')
export class DesignController {
  constructor(private readonly designs: DesignService) {}

  @Get('design')
  get(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    return this.designs.get(req.auth, parse(designQuery, query).documentTypeId ?? null);
  }

  @Put('design')
  put(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    return this.designs.put(req.auth, parse(putDesignSchema, body));
  }
}

/**
 * Drafting with the assistant ("New policy/procedure with the assistant").
 * Of the AI module, and only where the policies module is on too: a client
 * without either has no such routes. For those who may create documents
 * (`policies.manage`); each conversation is its author's own. Nothing here
 * approves, publishes or changes a controlled document.
 */
@Controller('ai/drafts')
@UseGuards(SessionGuard)
@ForModule('ai_assistant')
export class DraftingController {
  constructor(private readonly drafting: DraftingService) {}

  private allow(req: AuthedRequest) {
    if (!req.auth.tenant.modules.includes('policies')) throw noSuchRoute(req);
    requirePermission(req, 'policies.manage');
  }

  @Get()
  list(@Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.list(req.auth);
  }

  @Post()
  start(@Body() body: unknown, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.start(req.auth, parse(startSchema, body));
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.get(req.auth, parseId(id));
  }

  @Post(':id/questions')
  @HttpCode(200)
  questions(@Param('id') id: string, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.askRound(req.auth, parseId(id));
  }

  @Post(':id/answers')
  @HttpCode(200)
  answer(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.answer(req.auth, parseId(id), parse(answerSchema, body));
  }

  @Post(':id/draft')
  @HttpCode(200)
  draft(@Param('id') id: string, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.draft(req.auth, parseId(id));
  }

  @Post(':id/revisions')
  @HttpCode(200)
  revise(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.revise(req.auth, parseId(id), parse(reviseSchema, body));
  }

  @Post(':id/edits')
  @HttpCode(200)
  edit(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.edit(req.auth, parseId(id), parse(editSchema, body));
  }

  @Post(':id/hand-over')
  handOver(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    this.allow(req);
    return this.drafting.handOver(req.auth, parseId(id), parse(handOverSchema, body));
  }

  @Post(':id/discard')
  @HttpCode(204)
  async discard(@Param('id') id: string, @Req() req: AuthedRequest) {
    this.allow(req);
    await this.drafting.discard(req.auth, parseId(id));
  }
}

/**
 * What an AI-drafted document carries in the policies module: the
 * conversation behind it, for those who see the document in full, and
 * taking ownership of it. Of the policies module, so that a document can be
 * owned and sent for review whatever happens to the AI module.
 */
@Controller('policies/documents')
@UseGuards(SessionGuard)
@ForModule('policies')
export class AiDraftController {
  constructor(private readonly drafting: DraftingService) {}

  @Get(':id/ai-draft')
  behind(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.drafting.behindDocument(req.auth, parseId(id));
  }

  @Post(':id/ai-draft/ownership')
  @HttpCode(200)
  takeOwnership(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.drafting.takeOwnership(req.auth, parseId(id));
  }
}
