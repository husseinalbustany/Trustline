import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SUPPORTED_LOCALES, type Locale } from '../i18n/locales.js';
import { requireEverywhere, requirePermission, SessionGuard, type AuthedRequest } from '../identity/session.guard.js';
import { CSV_CONTENT_TYPE } from '../policies/csv.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import { correctionSchema, historyQuery, incidentsExportQuery, incidentsQuery, seriesExportQuery, seriesQuery, settingsSchema } from './input.js';
import { ReportsService } from './reports.service.js';

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

/** A file's language: the one asked for, if the client works in it; else the client's own. */
function fileLocale(req: AuthedRequest, asked: Locale | undefined): Locale {
  const ours = (l: string | undefined): l is Locale =>
    !!l && req.auth.tenant.locales.includes(l) && (SUPPORTED_LOCALES as readonly string[]).includes(l);
  if (asked) {
    if (!ours(asked)) throw new BadRequestException({ code: 'language_mismatch' });
    return asked;
  }
  return ours(req.auth.tenant.defaultLocale) ? req.auth.tenant.defaultLocale : 'en';
}

/**
 * The Reports API (docs/specs/reports-and-measures.md, "API outline"):
 * the measures month by month and the month so far, each month's
 * revisions, the CSV, corrections, and the client's targets and baseline.
 * `reports.view` on every route, then the scope of each figure
 * (ReportsService). Reads stay open while suspended.
 */
@Controller('reports')
@UseGuards(SessionGuard)
@ForModule('core')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('measures')
  measures(@Query() query: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'reports.view');
    return this.reports.measures(req.auth, parse(seriesQuery, query));
  }

  @Get('measures/:code/history')
  history(@Param('code') code: string, @Query() query: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'reports.view');
    return this.reports.history(req.auth, code, parse(historyQuery, query));
  }

  @Get('exports/measures')
  async exportMeasures(@Query() query: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    requirePermission(req, 'reports.view');
    const { locale, ...series } = parse(seriesExportQuery, query);
    const file = await this.reports.exportMeasures(req.auth, series, fileLocale(req, locale));
    res.setHeader('Content-Type', CSV_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return file.body;
  }

  /** The reports of a period by month, type, harm level, category, unit or channel. */
  @Get('incidents')
  incidents(@Query() query: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'reports.view');
    return this.reports.incidents(req.auth, parse(incidentsQuery, query));
  }

  @Get('exports/incidents')
  async exportIncidents(@Query() query: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    requirePermission(req, 'reports.view');
    const { locale, ...breakdown } = parse(incidentsExportQuery, query);
    const file = await this.reports.exportIncidents(req.auth, breakdown, fileLocale(req, locale));
    res.setHeader('Content-Type', CSV_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return file.body;
  }

  /** A correction, recomputed by Trustline: for the whole organization's `reports.manage`. */
  @Post('measures/corrections')
  @HttpCode(201)
  correct(@Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'reports.view');
    requireEverywhere(req, 'reports.manage');
    return this.reports.correct(req.auth, parse(correctionSchema, body));
  }

  @Get('settings')
  settings(@Req() req: AuthedRequest) {
    requirePermission(req, 'reports.view');
    requireEverywhere(req, 'reports.view');
    return this.reports.settings(req.auth);
  }

  @Patch('settings')
  updateSettings(@Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'reports.view');
    requireEverywhere(req, 'reports.manage');
    return this.reports.updateSettings(req.auth, parse(settingsSchema, body));
  }
}
