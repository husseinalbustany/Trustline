-- What the application role may do on the identity tables. Row-level security
-- further limits every statement to one tenant.
GRANT SELECT, INSERT, UPDATE ON users TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON role_assignments TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON user_tokens TO trustline_app;--> statement-breakpoint
-- Append-only: no UPDATE or DELETE.
GRANT SELECT, INSERT ON audit_log TO trustline_app;
