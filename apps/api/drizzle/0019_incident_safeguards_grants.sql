-- The one thing the application role may change on a client record: whether
-- the hospital takes reports without sign-in. The tenants_app_own_settings
-- policy limits it to the hospital the transaction acts for, so the role can
-- neither rename, suspend or re-plan a client, nor switch this on for another.
GRANT UPDATE (public_reporting) ON tenants TO trustline_app;
