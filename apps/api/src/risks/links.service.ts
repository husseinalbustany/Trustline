import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { riskCategories, riskControls, riskIncidentLinks, risks } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { covers } from '../identity/scope.js';
import { LinkedIncidents } from '../incidents/linked-incidents.js';
import { LinkedDocuments } from '../policies/linked-documents.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { addEvent, namesOf, notYours, summaryOf, todayOf } from './common.js';
import { matrixInUseId } from './matrix.js';
import { IMPACT_OF_HARM, RiskRegisterService } from './register.service.js';
import { RiskNotifier } from './risk-notifier.js';
import { riskViewerOf, roleOf, visible } from './visibility.js';

const linkColumns = {
  id: riskIncidentLinks.id,
  riskId: riskIncidentLinks.riskId,
  incidentId: riskIncidentLinks.incidentId,
  kind: riskIncidentLinks.kind,
  note: riskIncidentLinks.note,
  linkedBy: riskIncidentLinks.linkedBy,
  linkedAt: riskIncidentLinks.linkedAt,
};

/**
 * Links between risks and the other modules (step 7 of
 * docs/specs/risk-management.md, "Links to other modules"): incidents that
 * raised or support a risk, and documents named as controls. A link shows
 * only while both modules are on, and only as each module lets the reader
 * see its side: an incident only to someone who sees it in full, and never
 * who reported it, how, or whether anonymously (not in a link, a count or
 * a notification); a document as `LinkedDocuments` describes it. A link to
 * another client's record is refused as one that does not exist.
 */
@Injectable()
export class RiskLinksService implements OnModuleInit {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly register: RiskRegisterService,
    private readonly incidents: LinkedIncidents,
    private readonly documents: LinkedDocuments,
    private readonly notifier: RiskNotifier,
  ) {}

  /** Told when a document is retired: the owners of risks it is a control of. */
  onModuleInit() {
    this.documents.onRetired((tx, tenant, documentId, actorId) =>
      tenant.modules.includes('risks') ? this.documentRetired(tx, tenant.id, documentId, actorId) : Promise.resolve(),
    );
  }

  /**
   * In the transaction that retires a document: the owner of each risk on
   * the register with an active control naming it is told, while the
   * client has the risks module; the control shows the flag
   * `document_retired` from then on.
   */
  private async documentRetired(tx: Transaction, tenantId: string, documentId: string, actorId: string) {
    const rows = await tx
      .select({ id: risks.id, reference: risks.reference, currentBand: risks.currentBand, ownerId: risks.ownerId, controlId: riskControls.id })
      .from(riskControls)
      .innerJoin(risks, eq(risks.id, riskControls.riskId))
      .where(
        and(
          eq(riskControls.documentId, documentId),
          eq(riskControls.active, true),
          inArray(risks.status, ['open', 'proposed']),
        ),
      );
    for (const r of rows) {
      await this.notifier.send(tx, tenantId, r, actorId, [
        { kind: 'risk_control_document_retired', to: [r.ownerId], data: { controlId: r.controlId } },
      ]);
    }
  }

  // Incidents.

  /**
   * Links an incident to a risk on the register, for a manager of the risk
   * who sees the incident in full, with the kind of link and an optional
   * note: 400 `unknown_incident` for one they do not see, of another
   * client, that does not exist, or while the incidents module is off,
   * alike; 409 `already_linked`. The risk's owner is told, by the risk's
   * reference only.
   */
  link(auth: AuthContext, riskId: string, input: { incidentId: string; kind: 'raised' | 'supports'; note?: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.register.lock(tx, viewer, riskId);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.status !== 'open') throw new ConflictException({ code: 'not_on_register' });
      const incident = auth.tenant.modules.includes('incidents')
        ? await this.incidents.forLinking(tx, auth, input.incidentId)
        : null;
      if (!incident) throw new BadRequestException({ code: 'unknown_incident' });
      const [live] = await tx
        .select({ id: riskIncidentLinks.id })
        .from(riskIncidentLinks)
        .where(
          and(
            eq(riskIncidentLinks.riskId, riskId),
            eq(riskIncidentLinks.incidentId, incident.id),
            isNull(riskIncidentLinks.removedAt),
          ),
        );
      if (live) throw new ConflictException({ code: 'already_linked' });
      const [link] = await tx
        .insert(riskIncidentLinks)
        .values({
          tenantId: auth.tenant.id,
          riskId,
          incidentId: incident.id,
          kind: input.kind,
          note: input.note ?? null,
          linkedBy: auth.user.id,
        })
        .returning(linkColumns);
      const details = {
        linkId: link.id,
        incidentId: incident.id,
        incidentReference: incident.reference,
        kind: input.kind,
        noteGiven: !!input.note,
      };
      await addEvent(tx, auth, riskId, 'incident_linked', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_incident_linked', 'risk', riskId, details);
      await this.notifier.send(tx, auth.tenant.id, risk, auth.user.id, [{ kind: 'risk_incident_linked', to: [risk.ownerId] }]);
      const riskRevision = await this.register.touch(tx, riskId);
      return { ...link, riskRevision };
    });
  }

  /**
   * Takes a link off, with a reason kept on it (correctable), for a manager
   * of the risk who sees the incident in full; 404 otherwise, as for a
   * link that is not the risk's or already taken off.
   */
  unlink(auth: AuthContext, riskId: string, linkId: string, input: { reason: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.register.lock(tx, viewer, riskId);
      if (!roleOf(viewer, risk).manager) throw notYours();
      const [link] = await tx
        .select(linkColumns)
        .from(riskIncidentLinks)
        .where(and(eq(riskIncidentLinks.id, linkId), eq(riskIncidentLinks.riskId, riskId), isNull(riskIncidentLinks.removedAt)))
        .for('update');
      if (!link) throw new NotFoundException();
      const seen = auth.tenant.modules.includes('incidents') && (await this.incidents.forLinking(tx, auth, link.incidentId));
      if (!seen) throw new NotFoundException();
      await tx
        .update(riskIncidentLinks)
        .set({ removedBy: auth.user.id, removedAt: new Date(), removeReason: input.reason })
        .where(eq(riskIncidentLinks.id, linkId));
      const details = { linkId, incidentId: link.incidentId, reasonGiven: true };
      await addEvent(tx, auth, riskId, 'incident_unlinked', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_incident_unlinked', 'risk', riskId, details);
      await this.register.touch(tx, riskId);
    });
  }

  /**
   * The incident's panel of risks, for someone who sees the incident at all
   * (404 otherwise, and while the incidents module is off): the risks
   * linked to it that the caller reads in full, with the kind of link; and,
   * for someone who sees it in full, what "Raise a risk" offers (its unit,
   * and the impact its harm level suggests) and whether they may link it.
   */
  forIncident(auth: AuthContext, incidentId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      if (!auth.tenant.modules.includes('incidents')) throw new NotFoundException();
      if (!(await this.incidents.visible(tx, auth, incidentId))) throw new NotFoundException();
      const viewer = await riskViewerOf(tx, auth);
      const today = todayOf(auth);
      const linked = await tx
        .select({ riskId: riskIncidentLinks.riskId, kind: riskIncidentLinks.kind, linkId: riskIncidentLinks.id })
        .from(riskIncidentLinks)
        .where(and(eq(riskIncidentLinks.incidentId, incidentId), isNull(riskIncidentLinks.removedAt)));
      const kindOf = new Map(linked.map((l) => [l.riskId, l]));
      const rows = linked.length
        ? await this.register.rows(
            tx,
            today,
            and(visible(viewer), inArray(risks.id, [...kindOf.keys()]))!,
            [asc(risks.reference)],
            200,
          )
        : [];
      const inUse = await matrixInUseId(tx);
      const full = await this.incidents.forLinking(tx, auth, incidentId);
      return {
        items: rows.map((r) => ({ ...summaryOf(r, today, inUse), linkKind: kindOf.get(r.id)!.kind, linkId: kindOf.get(r.id)!.linkId })),
        raise: full
          ? { orgUnitId: full.orgUnitId, impact: IMPACT_OF_HARM[full.harmLevel] ?? null, linkKind: 'raised' as const }
          : null,
        // Linking from the incident's side is done from the risk's page,
        // by a manager of the risk.
        mayLink: !!full && (viewer.manageReach === 'all' || viewer.manageReach.length > 0),
        ...(await namesOf(tx, {
          people: rows.map((r) => r.ownerId),
          units: [...rows.map((r) => r.orgUnitId), full?.orgUnitId ?? null],
          categories: rows.map((r) => r.categoryId),
        })),
      };
    });
  }

  // Documents.

  /**
   * The risks a document is an active control of, for someone who may read
   * the document (404 otherwise, and while the policies module is off): how
   * many there are, and those the caller reads in full.
   */
  forDocument(auth: AuthContext, documentId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      if (!auth.tenant.modules.includes('policies')) throw new NotFoundException();
      if (!(await this.documents.readable(tx, auth, documentId))) throw new NotFoundException();
      const viewer = await riskViewerOf(tx, auth);
      const today = todayOf(auth);
      const controlled = sql`exists (select from ${riskControls} c where c.risk_id = ${risks.id}
        and c.document_id = ${documentId} and c.active)`;
      const where = and(inArray(risks.status, ['open', 'proposed']), controlled)!;
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(risks)
        .innerJoin(riskCategories, eq(riskCategories.id, risks.categoryId))
        .where(where);
      const rows = await this.register.rows(tx, today, and(where, visible(viewer))!, [asc(risks.reference)], 200);
      const inUse = await matrixInUseId(tx);
      return {
        total: covers(auth, 'risks.view', null) || covers(auth, 'risks.manage', null) ? total : rows.length,
        items: rows.map((r) => summaryOf(r, today, inUse)),
        ...(await namesOf(tx, { people: rows.map((r) => r.ownerId), units: rows.map((r) => r.orgUnitId) })),
      };
    });
  }
}
