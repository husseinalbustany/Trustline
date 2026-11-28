import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { mergeMap, type Observable } from 'rxjs';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { READS, type AuthedRequest } from '../identity/session.guard.js';

/** What a route's `:id` names, by the route. */
const RECORDS: [RegExp, string][] = [
  [/\/incidents\/:id(\/|$)/, 'incident'],
  [/\/policies\/documents\/:id(\/|$)/, 'document'],
  [/\/users\/:id(\/|$)/, 'user'],
];

/** Reads that are not of the client's records: who they are, their own notices. */
const NOT_RECORDS = /\/(auth|notifications)(\/|$)/;

/**
 * Every record an external reviewer opens, and every file they download,
 * is recorded (`external_reviewer_viewed`, docs/specs/audit-trail.md): the
 * client can then show what was examined. Written before the answer goes,
 * so that nothing is read unrecorded; the route, and the record it names.
 * Nobody else's reading is recorded.
 */
@Injectable()
export class ReviewerReads implements NestInterceptor {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Partial<AuthedRequest>>();
    const auth = req.auth;
    if (!auth || auth.user.kind !== 'external_reviewer' || !READS.has(req.method ?? '')) {
      return next.handle();
    }
    const route = `${req.baseUrl ?? ''}${(req.route as { path?: string } | undefined)?.path ?? req.path ?? ''}`;
    if (NOT_RECORDS.test(route)) return next.handle();
    const id = typeof req.params?.id === 'string' ? req.params.id : null;
    const recordType = id ? (RECORDS.find(([pattern]) => pattern.test(route))?.[1] ?? null) : null;
    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        await this.tenantDb.withTenant(auth.tenant.id, (tx) =>
          this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'external_reviewer_viewed', null, null, {
            route,
            recordType,
            recordId: recordType ? id : null,
          }),
        );
        return value;
      }),
    );
  }
}
