-- The admin portal's role only ever needs to count failed sign-ins and set a
-- lock. Without this it could overwrite an admin's password hash or email.
REVOKE UPDATE ON platform_admins FROM trustline_platform;--> statement-breakpoint
GRANT UPDATE (failed_attempts, locked_until) ON platform_admins TO trustline_platform;
