import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { requireEverywhere, requirePermission, SessionGuard, type AuthedRequest } from '../identity/session.guard.js';
import { ForModule, OpenInExitWindow, OpenWhileSuspended } from '../subscriptions/module.decorator.js';
import { ExportsService } from './exports.service.js';
import { approveSchema, cancelSchema, downloadSchema, listQuery, refuseSchema, requestSchema } from './input.js';
import { ExportStorage } from './storage.js';

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

/**
 * Full data export (docs/specs/data-export.md, "API outline"): for holders
 * of `data.export` for the whole organization, on every route. Exporting
 * stays open while the subscription is suspended (decision 6). An export
 * of another client is 404. During a cancelled client's exit window,
 * these routes still answer, for its holders of `data.export`.
 */
@Controller('exports')
@UseGuards(SessionGuard)
@ForModule('core')
@OpenInExitWindow()
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly storage: ExportStorage,
  ) {}

  private allowed(req: AuthedRequest) {
    requirePermission(req, 'data.export');
    // An export holds everything: only a grant for all of it counts.
    requireEverywhere(req, 'data.export');
  }

  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    this.allowed(req);
    return this.exports.list(req.auth, parse(listQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OpenWhileSuspended()
  request(@Body() body: unknown, @Req() req: AuthedRequest) {
    this.allowed(req);
    return this.exports.request(req.auth, parse(requestSchema, body), req.ip ?? null);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @OpenWhileSuspended()
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    this.allowed(req);
    return this.exports.approve(req.auth, id, parse(approveSchema, body), req.ip ?? null);
  }

  @Post(':id/refuse')
  @HttpCode(200)
  @OpenWhileSuspended()
  refuse(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    this.allowed(req);
    return this.exports.refuse(req.auth, id, parse(refuseSchema, body), req.ip ?? null);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @OpenWhileSuspended()
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    this.allowed(req);
    return this.exports.cancel(req.auth, id, parse(cancelSchema, body), req.ip ?? null);
  }

  /** The archive itself, after the password again: counted and audited first. */
  @Post(':id/download')
  @HttpCode(200)
  @OpenWhileSuspended()
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    this.allowed(req);
    const file = await this.exports.download(req.auth, id, parse(downloadSchema, body), req.ip ?? null);
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (file.sizeBytes !== null) res.setHeader('Content-Length', String(file.sizeBytes));
    if (file.sha256) res.setHeader('X-Archive-SHA256', file.sha256);
    try {
      await this.storage.open(file.storageKey, file.wrappedKey, res);
    } catch {
      // Headers are sent: a download that fails is cut short, never ended
      // as if whole.
      res.destroy();
    }
  }
}
