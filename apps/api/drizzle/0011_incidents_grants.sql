-- What the application role may do on the incident tables. Row-level security
-- further limits every statement to one tenant. trustline_platform gets
-- nothing here: these are hospital data.
GRANT SELECT, INSERT, UPDATE ON incident_categories TO trustline_app;--> statement-breakpoint
-- An incident is never deleted by the application.
GRANT SELECT, INSERT, UPDATE ON incidents TO trustline_app;--> statement-breakpoint
-- The timeline is append-only, like audit_log: no UPDATE or DELETE.
GRANT SELECT, INSERT ON incident_events TO trustline_app;--> statement-breakpoint
-- A comment cannot be edited or removed once written.
GRANT SELECT, INSERT ON incident_comments TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON reference_counters TO trustline_app;
