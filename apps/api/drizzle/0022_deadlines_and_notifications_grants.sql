-- What the application role may do on the two new tables. Row-level security
-- further limits every statement to one tenant. trustline_platform gets
-- nothing here: these are hospital data.
-- A hospital changes its response rules; it never removes one.
GRANT SELECT, INSERT, UPDATE ON incident_response_rules TO trustline_app;--> statement-breakpoint
-- A notification is written once. All that can change afterwards is whether
-- it has been read: not who it was for, what it said, or when. No DELETE.
GRANT SELECT, INSERT ON notifications TO trustline_app;--> statement-breakpoint
GRANT UPDATE (read_at) ON notifications TO trustline_app;
-- tenants.time_zone needs no grant of its own. trustline_platform holds
-- INSERT and UPDATE on the whole of tenants (0003), which covers a new
-- column; trustline_app may read it (0001) and may update public_reporting
-- only (0019), so a hospital cannot move its own clock.
