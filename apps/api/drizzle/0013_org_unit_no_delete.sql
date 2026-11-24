-- An org unit is switched off, never deleted: incidents, users and role
-- grants point at it. The application role keeps SELECT, INSERT and UPDATE.
REVOKE DELETE ON org_units FROM trustline_app;
