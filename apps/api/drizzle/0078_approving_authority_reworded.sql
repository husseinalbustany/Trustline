-- The built-in Approving authority's description, reworded (language
-- review 11): its reading of the document measures named plainly, in the
-- three languages. Every client whose role still has the wording of 0067,
-- audited per client. A client's own role of that code is left alone.
-- Safe to repeat.
UPDATE "roles" SET "description" = jsonb_build_object(
    'en', 'Gives the final approval of controlled documents, reads every document (restricted ones and drafts included), and reads the document measures in Reports.',
    'ar', 'يتولى الاعتماد النهائي للوثائق المضبوطة، ويقرأ كل الوثائق بما فيها المقيّدة والمسودات، ويطّلع على مؤشرات الوثائق في التقارير.',
    'fr', 'Donne l’approbation finale des documents maîtrisés, lit tous les documents (brouillons et documents restreints compris) et consulte les indicateurs documentaires des rapports.'
  )
WHERE "is_system" AND "code" = 'approving_authority'
  AND "description" ->> 'en' = 'Gives the final approval of controlled documents, reads every document, restricted ones and drafts included, and views reports on documents.';--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT r."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', r."tenant_id",
  jsonb_build_object(
    'migration', '0078_approving_authority_reworded',
    'roles', jsonb_build_array('approving_authority'),
    'reworded', true
  )
FROM "roles" r
WHERE r."is_system" AND r."code" = 'approving_authority'
  AND r."description" ->> 'en' = 'Gives the final approval of controlled documents, reads every document (restricted ones and drafts included), and reads the document measures in Reports.'
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = r."tenant_id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0078_approving_authority_reworded'
  );
