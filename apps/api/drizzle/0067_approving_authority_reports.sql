-- The built-in Approving authority reads reports (docs/specs/reports-and-
-- measures.md, decision 6, answered by the business on 28 November 2026):
-- `reports.view`, for every client that has the role, with its
-- description saying so, audited per client. It sees only the document
-- measures: it has no incident permission. A client's own role of that
-- code is left alone. Safe to repeat.
UPDATE "roles" SET "permissions" = array_append("permissions", 'reports.view')
WHERE "is_system" AND "code" = 'approving_authority'
  AND NOT ('reports.view' = ANY ("permissions"));--> statement-breakpoint
UPDATE "roles" SET "description" = jsonb_build_object(
    'en', 'Gives the final approval of controlled documents, reads every document, restricted ones and drafts included, and views reports on documents.',
    'ar', 'يمنح الاعتماد النهائي للوثائق المضبوطة، ويقرأ كل الوثائق بما فيها المقيّدة والمسودات، ويطّلع على تقارير الوثائق.',
    'fr', 'Donne l’approbation finale des documents maîtrisés, lit tous les documents, y compris les documents restreints et les brouillons, et consulte les rapports sur les documents.'
  )
WHERE "is_system" AND "code" = 'approving_authority'
  AND "description" ->> 'en' = 'Gives the final approval of controlled documents, and reads every document, restricted ones and drafts included.';--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT r."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', r."tenant_id",
  jsonb_build_object(
    'migration', '0067_approving_authority_reports',
    'roles', jsonb_build_array('approving_authority'),
    'permissionsAdded', jsonb_build_array('reports.view'),
    'reworded', true
  )
FROM "roles" r
WHERE r."is_system" AND r."code" = 'approving_authority'
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = r."tenant_id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0067_approving_authority_reports'
  );
