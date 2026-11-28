-- A month's figure says when it was taken, and the database says so, not
-- the application (security review 16, L2, as 0063 did for the audit
-- trail): for the application role, `taken_at` is the moment of the
-- insert, whatever it sent. Safe to repeat.
CREATE OR REPLACE FUNCTION "measure_snapshots_taken_now"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user = 'trustline_app' THEN
    NEW.taken_at := now();
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "measure_snapshots_taken_now" ON "measure_snapshots";--> statement-breakpoint
CREATE TRIGGER "measure_snapshots_taken_now" BEFORE INSERT ON "measure_snapshots"
FOR EACH ROW EXECUTE FUNCTION "measure_snapshots_taken_now"();
