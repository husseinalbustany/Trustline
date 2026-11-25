import {
  BadRequestException,
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
import { SessionGuard, type AuthedRequest } from '../identity/session.guard.js';
import { NotificationsService } from './notifications.service.js';

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

// An empty value in the address (`?unread=`) means the filter is not set.
const blankAsUnset = (query: unknown) =>
  query && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''))
    : query;

const listSchema = z.preprocess(
  blankAsUnset,
  z.strictObject({
    unread: flag.default(false),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
);

/**
 * The notifications of the person signed in. No permission opens or closes
 * these routes: everyone has their own, and nobody has anyone else's. The
 * service limits every query to the caller.
 */
@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    return this.notifications.list(req.auth, parsed.data);
  }

  // Declared before ':id', as a habit: Nest would take "count" for an id.
  @Get('count')
  count(@Req() req: AuthedRequest) {
    return this.notifications.unread(req.auth);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@Req() req: AuthedRequest) {
    return this.notifications.markAllRead(req.auth);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@Param('id') id: string, @Req() req: AuthedRequest) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return this.notifications.markRead(req.auth, parsed.data);
  }
}
