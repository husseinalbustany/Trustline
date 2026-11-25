-- Limits on every session of the application role, whatever release or tool
-- opens it. Until now none was set: a statement could run, and a
-- transaction could wait for a lock or sit idle holding one, for ever, each
-- keeping one of the few connections all hospitals share.
--
-- Far above what any request needs (they take milliseconds), so nothing
-- that works is cut short; a statement that reaches one of these has gone
-- wrong and is given up, with an error the API answers as a 500 and logs by
-- its class (57014, 55P03, 25P03).
--
-- They apply to sessions opened after this, and to trustline_app only:
-- migrations and the seed run as the owner role and are not limited.
ALTER ROLE "trustline_app" SET statement_timeout = '15s';--> statement-breakpoint
ALTER ROLE "trustline_app" SET lock_timeout = '5s';--> statement-breakpoint
-- A transaction left open with nothing running in it, by a process that
-- hung or lost its way: ended, so the locks it holds are let go. Among them
-- the lock under which a hospital's public reports are counted, which would
-- otherwise keep that hospital's form answering "try again".
ALTER ROLE "trustline_app" SET idle_in_transaction_session_timeout = '60s';
