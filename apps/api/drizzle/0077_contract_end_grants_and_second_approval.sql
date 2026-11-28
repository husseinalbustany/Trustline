-- The end of a contract (docs/specs/data-export.md, steps 6 and 7): what
-- each role may read and write of it, and Trustline's second approval of
-- an export, for a client with one holder of `data.export` (decision 3).
-- Safe to repeat.

-- 1. The application reads the contract's dates (the exit window, the
-- notices); only the portal writes them.
GRANT SELECT ("ends_on", "exit_until", "retain_until") ON "subscriptions" TO trustline_app;--> statement-breakpoint

-- 2. Trustline's staff see an export's status, reason, times, size and
-- downloads, never who asked: names are the client's.
GRANT SELECT ("id", "tenant_id", "status", "reason", "requested_at", "approved_at", "trustline_approved_at", "refused_at",
  "cancelled_at", "ready_at", "expires_at", "expired_at", "size_bytes", "downloads", "last_downloaded_at")
  ON "data_exports" TO trustline_platform;--> statement-breakpoint

-- 3. Deletions are Trustline's own records: the portal asks and approves,
-- the command line (as the owner) carries them out. Never deleted.
GRANT SELECT, INSERT, UPDATE ON "client_deletions" TO trustline_platform;--> statement-breakpoint

-- 4. Trustline's second approval. The platform role may read nobody's
-- roles, so the database checks that nobody else of the client could
-- approve (another holder, independent of the person who asked), records the
-- approval with the written request, writes the client's audit entry and
-- tells those the routes tell, in the caller's transaction. It answers
-- 'ok', or why not: 'not_found', 'not_requested', 'lapsed', 'not_alone'.
CREATE OR REPLACE FUNCTION "data_export_second_approval"(
  p_tenant uuid, p_export uuid, p_admin uuid, p_admin_name text, p_request jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  e record;
  holders integer;
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object'
     OR NOT (p_request ?& ARRAY['receivedOn', 'from', 'reference']) THEN
    RAISE EXCEPTION 'a written request is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id, status, lapses_at, requested_by INTO e
  FROM public.data_exports WHERE id = p_export AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF e.status <> 'requested' THEN RETURN 'not_requested'; END IF;
  IF e.lapses_at <= now() THEN RETURN 'lapsed'; END IF;
  -- Another holder who could approve: `data.export` with
  -- `incidents.see_reporter` for the whole organization, an account and a
  -- grant at least 7 days old and not made by the person who asked
  -- (security review 19, L1 and M3).
  SELECT count(DISTINCT u.id) INTO holders
  FROM public.role_assignments ra
  JOIN public.roles r ON r.id = ra.role_id AND r.tenant_id = p_tenant
  JOIN public.users u ON u.id = ra.user_id AND u.tenant_id = p_tenant
  WHERE ra.tenant_id = p_tenant AND ra.org_unit_id IS NULL AND 'data.export' = ANY (r.permissions)
    AND u.status = 'active' AND u.kind = 'staff' AND u.id <> e.requested_by
    AND u.created_at <= now() - interval '7 days'
    AND ra.granted_at <= now() - interval '7 days' AND ra.granted_by IS DISTINCT FROM e.requested_by
    AND NOT EXISTS (
      SELECT FROM public.audit_log a
      WHERE a.tenant_id = p_tenant AND a.action = 'user_created' AND a.entity_id = u.id AND a.actor_id = e.requested_by)
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
REVOKE ALL ON FUNCTION "data_export_second_approval"(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "data_export_second_approval"(uuid, uuid, uuid, text, jsonb) TO trustline_platform;
