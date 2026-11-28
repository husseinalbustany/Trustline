-- Security review 20 (docs/specs/data-export.md): who may write what of an
-- export, a deletion and Trustline's second approval, and the second
-- approval in two hands with its requester checked. Safe to repeat.

-- 1. The application changes an export's state, never Trustline's approval
-- of it (L8): every column but the approval's, the identity and the request.
REVOKE UPDATE ON "data_exports" FROM trustline_app;--> statement-breakpoint
GRANT UPDATE ("status", "approved_by", "approved_at", "refused_by", "refused_at", "refused_reason", "cancelled_at",
  "claimed_at", "phase", "attempts", "error_kind", "snapshot_at", "counts", "size_bytes", "archive_sha256",
  "manifest_sha256", "storage_key", "wrapped_key", "ready_at", "expires_at", "expired_at", "downloads",
  "last_downloaded_at", "revision", "updated_at")
  ON "data_exports" TO trustline_app;--> statement-breakpoint

-- 2. The written requests Trustline's staff record, and approve on.
GRANT SELECT, INSERT ON "export_second_approvals" TO trustline_platform;--> statement-breakpoint
GRANT UPDATE ("approved_by", "approved_at") ON "export_second_approvals" TO trustline_platform;--> statement-breakpoint

-- 3. A deletion's record (L4): the portal writes its status and approval
-- only, and only the moves the portal makes; its certificate is the
-- command line's, as the owner.
REVOKE UPDATE ON "client_deletions" FROM trustline_platform;--> statement-breakpoint
GRANT UPDATE ("status", "approved_by", "approved_at", "cancelled_at") ON "client_deletions" TO trustline_platform;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "client_deletions_moves"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user = 'trustline_platform' AND NOT (
    (OLD.status = 'requested' AND NEW.status IN ('requested', 'approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('approved', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'a deletion moves from requested to approved or cancelled, and from approved to cancelled'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'client_deletions_moves', TABLE = 'client_deletions';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_deletions_moves" ON "client_deletions";--> statement-breakpoint
CREATE TRIGGER "client_deletions_moves" BEFORE UPDATE ON "client_deletions"
FOR EACH ROW EXECUTE FUNCTION "client_deletions_moves"();--> statement-breakpoint

-- 4. Trustline's second approval, in two hands (M2), and independent of the
-- person who asked (M1, M2). It answers 'ok', or why not: 'not_found',
-- 'not_requested', 'lapsed', 'same_person', 'requester_not_independent',
-- 'not_alone'.
DROP FUNCTION IF EXISTS "data_export_second_approval"(uuid, uuid, uuid, text, jsonb);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "data_export_second_approval"(
  p_tenant uuid, p_export uuid, p_admin uuid, p_admin_name text, p_request jsonb, p_recorded_by uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  e record;
  holders integer;
  dependent boolean;
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object'
     OR NOT (p_request ?& ARRAY['receivedOn', 'from', 'reference']) THEN
    RAISE EXCEPTION 'a written request is required' USING ERRCODE = 'check_violation';
  END IF;
  -- One member of staff records the request, another approves on it.
  IF p_recorded_by IS NULL OR p_recorded_by = p_admin THEN RETURN 'same_person'; END IF;
  SELECT id, status, lapses_at, requested_by INTO e
  FROM public.data_exports WHERE id = p_export AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF e.status <> 'requested' THEN RETURN 'not_requested'; END IF;
  IF e.lapses_at <= now() THEN RETURN 'lapsed'; END IF;
  -- The person who asked: not an account the platform made, nor one made
  -- or given its password this week.
  SELECT u.created_at > now() - interval '7 days'
      OR coalesce(u.password_changed_at > now() - interval '7 days', false)
      OR EXISTS (
        SELECT FROM public.audit_log a
        WHERE a.tenant_id = p_tenant AND a.action = 'administrator_created_by_platform' AND a.entity_id = u.id)
    INTO dependent
  FROM public.users u WHERE u.id = e.requested_by AND u.tenant_id = p_tenant;
  IF dependent IS NOT FALSE THEN RETURN 'requester_not_independent'; END IF;
  -- Another holder who could approve, under the application's own rule
  -- (exports.service.ts, `dependenceOf`).
  SELECT count(DISTINCT u.id) INTO holders
  FROM public.role_assignments ra
  JOIN public.roles r ON r.id = ra.role_id AND r.tenant_id = p_tenant
  JOIN public.users u ON u.id = ra.user_id AND u.tenant_id = p_tenant
  WHERE ra.tenant_id = p_tenant AND ra.org_unit_id IS NULL AND 'data.export' = ANY (r.permissions)
    AND u.status = 'active' AND u.kind = 'staff' AND u.id <> e.requested_by
    AND u.created_at <= now() - interval '7 days'
    AND NOT coalesce(u.password_changed_at > now() - interval '7 days', false)
    AND ra.granted_at <= now() - interval '7 days' AND ra.granted_by IS DISTINCT FROM e.requested_by
    AND NOT EXISTS (
      SELECT FROM public.audit_log a
      WHERE a.tenant_id = p_tenant AND a.entity_id = u.id AND a.actor_id = e.requested_by
        AND (a.action = 'user_created' OR (a.action = 'sign_in_link_created' AND a.occurred_at > now() - interval '7 days')))
    AND NOT EXISTS (
      SELECT FROM public.audit_log a
      JOIN public.role_assignments held ON held.role_id = a.entity_id AND held.user_id = u.id
      WHERE a.tenant_id = p_tenant AND a.action = 'role_updated' AND a.occurred_at > now() - interval '7 days'
        AND ((coalesce(a.changes -> 'after', '[]') ? 'data.export' AND NOT coalesce(a.changes -> 'before', '[]') ? 'data.export')
          OR (coalesce(a.changes -> 'after', '[]') ? 'incidents.see_reporter' AND NOT coalesce(a.changes -> 'before', '[]') ? 'incidents.see_reporter')))
    AND EXISTS (
      SELECT FROM public.role_assignments ra2
      JOIN public.roles r2 ON r2.id = ra2.role_id AND r2.tenant_id = p_tenant
      WHERE ra2.tenant_id = p_tenant AND ra2.user_id = u.id AND ra2.org_unit_id IS NULL
        AND 'incidents.see_reporter' = ANY (r2.permissions));
  IF holders > 0 THEN RETURN 'not_alone'; END IF;
  UPDATE public.data_exports
  SET status = 'approved', trustline_approved_by = p_admin, trustline_approved_at = now(),
      written_request = p_request, revision = revision + 1, updated_at = now()
  WHERE id = p_export;
  INSERT INTO public.audit_log (tenant_id, action, entity_type, entity_id, changes)
  VALUES (p_tenant, 'data_export_approved_by_trustline', 'tenant', p_tenant, jsonb_build_object(
    'exportId', p_export, 'writtenRequest', p_request, 'platformAdminId', p_admin, 'platformAdminName', p_admin_name));
  INSERT INTO public.notifications (tenant_id, user_id, kind, data)
  SELECT p_tenant, t.id, 'data_export_changed', jsonb_build_object('change', 'approved', 'exportId', p_export, 'serious', false)
  FROM (
    SELECT DISTINCT u.id
    FROM public.role_assignments ra
    JOIN public.roles r ON r.id = ra.role_id AND r.tenant_id = p_tenant
    JOIN public.users u ON u.id = ra.user_id AND u.tenant_id = p_tenant
    WHERE ra.tenant_id = p_tenant AND ra.org_unit_id IS NULL AND u.status = 'active' AND u.kind = 'staff'
      AND r.permissions && ARRAY['data.export', 'settings.manage']
    UNION
    SELECT e.requested_by
  ) t;
  RETURN 'ok';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "data_export_second_approval"(uuid, uuid, uuid, text, jsonb, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "data_export_second_approval"(uuid, uuid, uuid, text, jsonb, uuid) TO trustline_platform;
