-- The built-in "External reviewer" role, reworded (language review 10):
-- «مقيّم خارجي» in Arabic, as accreditation bodies call surveyors, and a
-- description in the form of the other built-in roles. Every client that
-- has it, audited per client. A client's own role of that code is left
-- alone. Safe to repeat.
UPDATE "roles" SET
  "name" = jsonb_build_object('en', 'External reviewer', 'ar', 'مقيّم خارجي', 'fr', 'Évaluateur externe'),
  "description" = jsonb_build_object(
    'en', 'Reads, for a limited time, the audit trail, all documents, reports, and incidents without the reporters'' names. For surveyors and auditors from outside.',
    'ar', 'يطّلع لمدة محدودة على سجل التدقيق وجميع الوثائق والتقارير، وعلى الحوادث دون أسماء المبلّغين. للمقيّمين والمدققين من خارج المنشأة.',
    'fr', 'Consulte pour une durée limitée le journal d’audit, tous les documents, les rapports et les incidents sans le nom des déclarants. Pour les évaluateurs et auditeurs extérieurs.'
  )
WHERE "is_system" AND "code" = 'external_reviewer'
  AND "name" ->> 'ar' IS DISTINCT FROM 'مقيّم خارجي';--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT r."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', r."tenant_id",
  jsonb_build_object(
    'migration', '0064_external_reviewer_reworded',
    'roles', jsonb_build_array('external_reviewer'),
    'reworded', true
  )
FROM "roles" r
WHERE r."is_system" AND r."code" = 'external_reviewer'
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = r."tenant_id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0064_external_reviewer_reworded'
  );
