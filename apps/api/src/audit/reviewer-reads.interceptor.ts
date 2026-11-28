import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, mergeMap, type Observable } from 'rxjs';
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
    const params = Object.fromEntries(
      Object.entries(req.params ?? {}).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    const id = params.id ?? null;
    const recordType = id ? (RECORDS.find(([pattern]) => pattern.test(route))?.[1] ?? null) : null;
    // What was asked, as well as where (security review 14, L2): every
    // parameter of the route and of the query, a search by its length only.
    const query = Object.fromEntries(
      Object.entries((req.query ?? {}) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k, k === 'q' ? `(${(v as string).length})` : (v as string).slice(0, 200)]),
    );
    // Recorded before the answer is made, so that nothing, a file streamed
    // as it is read included, goes out unrecorded.
    return from(
      this.tenantDb.withTenant(auth.tenant.id, (tx) =>
        this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'external_reviewer_viewed', null, null, {
          route,
          recordType,
          recordId: recordType ? id : null,
          params,
          query,
        }),
      ),
    ).pipe(mergeMap(() => next.handle()));
  }
}
