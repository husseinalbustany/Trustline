-- Email (docs/specs/email.md): what the application role may do on the
-- tables of migration 0046. Row-level security further limits every
-- statement to one tenant. trustline_platform gets nothing: these are client
-- data. Nothing the release running from before this migration does touches
-- these tables, so nothing it does is refused. Every statement is safe to
-- repeat.

-- An organization's switch, and the day its digests were queued: one row,
-- changed in place.
GRANT SELECT, INSERT, UPDATE ON email_settings TO trustline_app;--> statement-breakpoint
-- A person's two switches: one row, changed in place.
GRANT SELECT, INSERT, UPDATE ON email_preferences TO trustline_app;--> statement-breakpoint
-- The queue: written when a notification is, claimed and finished by the
-- worker, and deleted by it 30 days after it is finished.
GRANT SELECT, INSERT, UPDATE, DELETE ON email_queue TO trustline_app;--> statement-breakpoint
-- What was kept instead of sent: written once, deleted after 30 days.
GRANT SELECT, INSERT, DELETE ON email_outbox TO trustline_app;
