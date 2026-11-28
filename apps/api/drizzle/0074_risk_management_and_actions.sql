CREATE TYPE "public"."action_effectiveness" AS ENUM('effective', 'not_effective');--> statement-breakpoint
CREATE TYPE "public"."action_event_kind" AS ENUM('created', 'updated', 'due_changed', 'completed', 'verified', 'cancelled', 'reopened', 'text_corrected');--> statement-breakpoint
CREATE TYPE "public"."action_hierarchy" AS ENUM('elimination', 'substitution', 'engineering', 'administrative', 'protective_equipment');--> statement-breakpoint
CREATE TYPE "public"."action_note_kind" AS ENUM('due_change_reason', 'reopen_reason');--> statement-breakpoint
CREATE TYPE "public"."action_source" AS ENUM('risk');--> statement-breakpoint
CREATE TYPE "public"."action_status" AS ENUM('open', 'in_progress', 'completed', 'verified', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."action_strength" AS ENUM('stronger', 'intermediate', 'weaker');--> statement-breakpoint
CREATE TYPE "public"."risk_acceptance_status" AS ENUM('in_approval', 'accepted', 'returned', 'withdrawn', 'lapsed');--> statement-breakpoint
CREATE TYPE "public"."risk_appetite" AS ENUM('averse', 'minimal', 'cautious', 'open', 'eager');--> statement-breakpoint
CREATE TYPE "public"."risk_axis" AS ENUM('likelihood', 'impact');--> statement-breakpoint
CREATE TYPE "public"."risk_band" AS ENUM('low', 'medium', 'high', 'extreme');--> statement-breakpoint
CREATE TYPE "public"."risk_control_effectiveness" AS ENUM('not_assessed', 'effective', 'partly_effective', 'ineffective');--> statement-breakpoint
CREATE TYPE "public"."risk_control_hierarchy" AS ENUM('elimination', 'substitution', 'engineering', 'administrative', 'protective_equipment');--> statement-breakpoint
CREATE TYPE "public"."risk_control_kind" AS ENUM('preventive', 'detective', 'mitigating');--> statement-breakpoint
CREATE TYPE "public"."risk_event_kind" AS ENUM('created', 'updated', 'rated', 'control_added', 'control_updated', 'proposal_accepted', 'proposal_rejected', 'rebanded', 'reviewed', 'escalated', 'de_escalated', 'text_corrected', 'acceptance_requested', 'acceptance_step_approved', 'acceptance_returned', 'acceptance_withdrawn', 'accepted', 'acceptance_lapsed', 'closure_requested', 'closure_step_approved', 'closure_returned', 'closed', 'reopened', 'incident_linked', 'incident_unlinked');--> statement-breakpoint
CREATE TYPE "public"."risk_incident_link_kind" AS ENUM('raised', 'supports');--> statement-breakpoint
CREATE TYPE "public"."risk_matrix_status" AS ENUM('draft', 'in_use', 'retired');--> statement-breakpoint
CREATE TYPE "public"."risk_note_kind" AS ENUM('change_reason', 'escalation_reason', 'de_escalation_reason', 'reopen_reason', 'withdraw_reason');--> statement-breakpoint
CREATE TYPE "public"."risk_rating_kind" AS ENUM('inherent', 'current', 'target');--> statement-breakpoint
CREATE TYPE "public"."risk_review_outcome" AS ENUM('no_change', 're_rated', 'treatment_changed', 'closure_proposed');--> statement-breakpoint
CREATE TYPE "public"."risk_source" AS ENUM('manual', 'incident', 'assessment', 'investigation', 'ai_suggestion');--> statement-breakpoint
CREATE TYPE "public"."risk_status" AS ENUM('proposed', 'open', 'closed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."risk_treatment" AS ENUM('reduce', 'avoid', 'share', 'accept');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_owner_assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_review_due';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_review_overdue';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_above_tolerance';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_escalated';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_de_escalated';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risks_overdue_digest';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'action_assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'action_due_soon';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'action_overdue';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'action_escalated';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'action_completed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_step_assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_step_overdue';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_acceptance_decided';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_acceptance_ending';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_acceptance_lapsed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_closed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_proposed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_incident_linked';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'risk_control_document_retired';--> statement-breakpoint
ALTER TYPE "public"."signature_meaning" ADD VALUE 'risk_accepted';--> statement-breakpoint
ALTER TYPE "public"."signature_meaning" ADD VALUE 'risk_closure_approved';--> statement-breakpoint
CREATE TABLE "action_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"kind" "action_event_kind" NOT NULL,
	"actor_id" uuid,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "action_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "action_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"kind" "action_note_kind" NOT NULL,
	"text" text NOT NULL,
	"written_by" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"corrected_by" uuid,
	"corrected_at" timestamp with time zone,
	CONSTRAINT "action_notes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "action_notes_text" CHECK (length("action_notes"."text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "action_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "action_reminders" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"action_id" uuid NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_reminders_pkey" PRIMARY KEY("tenant_id","kind","action_id","period"),
	CONSTRAINT "action_reminders_kind" CHECK ("action_reminders"."kind" in ('due_soon', 'overdue', 'escalated'))
);
--> statement-breakpoint
ALTER TABLE "action_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"source_type" "action_source" NOT NULL,
	"risk_id" uuid,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"owner_id" uuid NOT NULL,
	"org_unit_id" uuid,
	"due_on" date NOT NULL,
	"original_due_on" date NOT NULL,
	"strength" "action_strength" NOT NULL,
	"hierarchy" "action_hierarchy",
	"status" "action_status" DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"completion_note" text,
	"effectiveness" "action_effectiveness",
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"verification_note" text,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "actions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "actions_tenant_id_reference_key" UNIQUE("tenant_id","reference"),
	CONSTRAINT "actions_source_column" CHECK (("actions"."source_type" = 'risk') = ("actions"."risk_id" is not null)),
	CONSTRAINT "actions_completed_with_note" CHECK ("actions"."status" not in ('completed', 'verified') or ("actions"."completed_at" is not null and "actions"."completed_by" is not null and "actions"."completion_note" is not null)),
	CONSTRAINT "actions_verified_with_outcome" CHECK ("actions"."status" <> 'verified' or ("actions"."effectiveness" is not null and "actions"."verified_by" is not null and "actions"."verified_at" is not null)),
	CONSTRAINT "actions_cancelled_with_reason" CHECK ("actions"."status" <> 'cancelled' or "actions"."cancel_reason" is not null),
	CONSTRAINT "actions_reference_shape" CHECK ("actions"."reference" ~ '^ACT-[0-9]{4}-[0-9]{5,}$')
);
--> statement-breakpoint
ALTER TABLE "actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rationale" jsonb NOT NULL,
	"conditions" jsonb,
	"until_on" date NOT NULL,
	"rating_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"band_code" "risk_band" NOT NULL,
	"tolerance_band" "risk_band" NOT NULL,
	"category_id" uuid NOT NULL,
	"status" "risk_acceptance_status" NOT NULL,
	"approval_run_id" uuid,
	"decided_at" timestamp with time zone,
	"lapsed_reason" text,
	"lapsed_at" timestamp with time zone,
	CONSTRAINT "risk_acceptances_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_acceptances_lapsed_why" CHECK ("risk_acceptances"."status" <> 'lapsed' or ("risk_acceptances"."lapsed_reason" in ('last_day', 'score_risen', 'category_changed') and "risk_acceptances"."lapsed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "risk_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"code" "risk_band" NOT NULL,
	"name" jsonb NOT NULL,
	"review_interval_days" integer NOT NULL,
	"escalate_to_committee_id" uuid,
	"acceptance_needs_signature" boolean DEFAULT true NOT NULL,
	CONSTRAINT "risk_bands_code_key" UNIQUE("tenant_id","matrix_id","code"),
	CONSTRAINT "risk_bands_review_interval" CHECK ("risk_bands"."review_interval_days" between 1 and 730),
	CONSTRAINT "risk_bands_signature_when_serious" CHECK ("risk_bands"."acceptance_needs_signature" or "risk_bands"."code" in ('low', 'medium'))
);
--> statement-breakpoint
ALTER TABLE "risk_bands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"appetite" "risk_appetite" DEFAULT 'cautious' NOT NULL,
	"appetite_statement" jsonb,
	"tolerance_band" "risk_band" DEFAULT 'medium' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_categories_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_categories_tenant_id_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "risk_categories_code_shape" CHECK ("risk_categories"."code" ~ '^[a-z][a-z0-9_]{1,39}$')
);
--> statement-breakpoint
ALTER TABLE "risk_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_committees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"member_role_id" uuid,
	"chair_role_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_committees_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_committees_tenant_id_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "risk_committees_code_shape" CHECK ("risk_committees"."code" ~ '^[a-z][a-z0-9_]{1,39}$')
);
--> statement-breakpoint
ALTER TABLE "risk_committees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_controls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"description" jsonb NOT NULL,
	"kind" "risk_control_kind" NOT NULL,
	"hierarchy" "risk_control_hierarchy",
	"owner_id" uuid NOT NULL,
	"effectiveness" "risk_control_effectiveness" DEFAULT 'not_assessed' NOT NULL,
	"assessed_on" date,
	"document_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"inactive_reason" text,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_controls_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_controls_assessed_when" CHECK ("risk_controls"."effectiveness" = 'not_assessed' or "risk_controls"."assessed_on" is not null),
	CONSTRAINT "risk_controls_off_with_reason" CHECK ("risk_controls"."active" or "risk_controls"."inactive_reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "risk_controls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"kind" "risk_event_kind" NOT NULL,
	"actor_id" uuid,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "risk_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_impact_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"descriptors" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "risk_impact_domains_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "risk_impact_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_incident_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" "risk_incident_link_kind" NOT NULL,
	"note" text,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	"remove_reason" text,
	CONSTRAINT "risk_incident_links_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_incident_links_removed_with_reason" CHECK ("risk_incident_links"."removed_at" is null or ("risk_incident_links"."removed_by" is not null and "risk_incident_links"."remove_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "risk_incident_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_matrices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"likelihood_levels" integer NOT NULL,
	"impact_levels" integer NOT NULL,
	"status" "risk_matrix_status" DEFAULT 'draft' NOT NULL,
	"put_in_use_at" timestamp with time zone,
	"put_in_use_by" uuid,
	"retired_at" timestamp with time zone,
	"created_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_matrices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_matrices_tenant_id_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "risk_matrices_size" CHECK ("risk_matrices"."likelihood_levels" between 3 and 6 and "risk_matrices"."impact_levels" between 3 and 6),
	CONSTRAINT "risk_matrices_version" CHECK ("risk_matrices"."version" >= 1),
	CONSTRAINT "risk_matrices_in_use_when" CHECK ("risk_matrices"."status" <> 'in_use' or "risk_matrices"."put_in_use_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "risk_matrices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_matrix_cells" (
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"likelihood" integer NOT NULL,
	"impact" integer NOT NULL,
	"band_code" "risk_band" NOT NULL,
	CONSTRAINT "risk_matrix_cells_pkey" PRIMARY KEY("tenant_id","matrix_id","likelihood","impact"),
	CONSTRAINT "risk_matrix_cells_with_band_key" UNIQUE("tenant_id","matrix_id","likelihood","impact","band_code"),
	CONSTRAINT "risk_matrix_cells_levels" CHECK ("risk_matrix_cells"."likelihood" between 1 and 6 and "risk_matrix_cells"."impact" between 1 and 6)
);
--> statement-breakpoint
ALTER TABLE "risk_matrix_cells" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_matrix_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"axis" "risk_axis" NOT NULL,
	"level" integer NOT NULL,
	"label" jsonb NOT NULL,
	"descriptor" jsonb,
	"frequency" jsonb,
	CONSTRAINT "risk_matrix_levels_once_key" UNIQUE("tenant_id","matrix_id","axis","level"),
	CONSTRAINT "risk_matrix_levels_level" CHECK ("risk_matrix_levels"."level" between 1 and 6),
	CONSTRAINT "risk_matrix_levels_frequency_of_likelihood" CHECK ("risk_matrix_levels"."axis" = 'likelihood' or "risk_matrix_levels"."frequency" is null)
);
--> statement-breakpoint
ALTER TABLE "risk_matrix_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"kind" "risk_note_kind" NOT NULL,
	"text" text NOT NULL,
	"written_by" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"corrected_by" uuid,
	"corrected_at" timestamp with time zone,
	CONSTRAINT "risk_notes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_notes_text" CHECK (length("risk_notes"."text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "risk_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"kind" "risk_rating_kind" NOT NULL,
	"likelihood" integer NOT NULL,
	"impact" integer NOT NULL,
	"score" integer NOT NULL,
	"band_code" "risk_band" NOT NULL,
	"matrix_id" uuid NOT NULL,
	"rationale" jsonb,
	"rated_by" uuid NOT NULL,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_id" uuid,
	CONSTRAINT "risk_ratings_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_ratings_score" CHECK ("risk_ratings"."score" = "risk_ratings"."likelihood" * "risk_ratings"."impact")
);
--> statement-breakpoint
ALTER TABLE "risk_ratings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_reminders" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_reminders_pkey" PRIMARY KEY("tenant_id","kind","subject_id","period"),
	CONSTRAINT "risk_reminders_kind" CHECK ("risk_reminders"."kind" in ('review_due', 'review_overdue', 'weekly_digest', 'step_overdue', 'acceptance_ending'))
);
--> statement-breakpoint
ALTER TABLE "risk_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"due_on" date,
	"reviewed_on" date NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"committee_id" uuid,
	"outcome" "risk_review_outcome" NOT NULL,
	"comment" text NOT NULL,
	"next_review_on" date NOT NULL,
	"late" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_reviews_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risk_reviews_comment" CHECK (length("risk_reviews"."comment") between 1 and 4000),
	CONSTRAINT "risk_reviews_next_after" CHECK ("risk_reviews"."next_review_on" > "risk_reviews"."reviewed_on")
);
--> statement-breakpoint
ALTER TABLE "risk_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risk_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"inherent_required" boolean DEFAULT true NOT NULL,
	"framework_document_id" uuid,
	"assessment_threshold_band" "risk_band" DEFAULT 'high' NOT NULL,
	"acceptance_max_months" integer DEFAULT 12 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_settings_acceptance_months" CHECK ("risk_settings"."acceptance_max_months" between 1 and 12)
);
--> statement-breakpoint
ALTER TABLE "risk_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"org_unit_id" uuid,
	"category_id" uuid NOT NULL,
	"title" jsonb NOT NULL,
	"cause" jsonb NOT NULL,
	"event" jsonb NOT NULL,
	"consequence" jsonb NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" "risk_status" NOT NULL,
	"source" "risk_source" DEFAULT 'manual' NOT NULL,
	"treatment" "risk_treatment",
	"target_on" date,
	"inherent_likelihood" integer,
	"inherent_impact" integer,
	"inherent_score" integer,
	"inherent_band" "risk_band",
	"inherent_matrix_id" uuid,
	"current_likelihood" integer,
	"current_impact" integer,
	"current_score" integer,
	"current_band" "risk_band",
	"current_matrix_id" uuid,
	"target_likelihood" integer,
	"target_impact" integer,
	"target_score" integer,
	"target_band" "risk_band",
	"target_matrix_id" uuid,
	"next_review_on" date,
	"last_reviewed_on" date,
	"escalated_to_committee_id" uuid,
	"escalated_at" timestamp with time zone,
	"highest_band" "risk_band",
	"closure_sign_off_needed" boolean DEFAULT false NOT NULL,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"acceptance_id" uuid,
	"close_reason" text,
	"merged_into_id" uuid,
	"closure_requested_by" uuid,
	"closure_requested_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "risks_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "risks_tenant_id_reference_key" UNIQUE("tenant_id","reference"),
	CONSTRAINT "risks_closed_when" CHECK ("risks"."status" <> 'closed' or ("risks"."closed_at" is not null and "risks"."close_reason" is not null)),
	CONSTRAINT "risks_not_merged_into_itself" CHECK ("risks"."merged_into_id" is distinct from "risks"."id"),
	CONSTRAINT "risks_ratings_whole" CHECK (num_nulls("risks"."inherent_likelihood", "risks"."inherent_impact", "risks"."inherent_score", "risks"."inherent_band", "risks"."inherent_matrix_id") in (0, 5) and num_nulls("risks"."current_likelihood", "risks"."current_impact", "risks"."current_score", "risks"."current_band", "risks"."current_matrix_id") in (0, 5) and num_nulls("risks"."target_likelihood", "risks"."target_impact", "risks"."target_score", "risks"."target_band", "risks"."target_matrix_id") in (0, 5)),
	CONSTRAINT "risks_scores" CHECK (("risks"."inherent_score" is null or "risks"."inherent_score" = "risks"."inherent_likelihood" * "risks"."inherent_impact") and ("risks"."current_score" is null or "risks"."current_score" = "risks"."current_likelihood" * "risks"."current_impact") and ("risks"."target_score" is null or "risks"."target_score" = "risks"."target_likelihood" * "risks"."target_impact")),
	CONSTRAINT "risks_open_is_rated" CHECK ("risks"."status" <> 'open' or "risks"."current_score" is not null),
	CONSTRAINT "risks_rejected_with_reason" CHECK ("risks"."status" <> 'rejected' or ("risks"."reject_reason" is not null and "risks"."rejected_at" is not null)),
	CONSTRAINT "risks_reference_shape" CHECK ("risks"."reference" ~ '^RSK-[0-9]{4}-[0-9]{5,}$')
);
--> statement-breakpoint
ALTER TABLE "risks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_routes" DROP CONSTRAINT "approval_routes_subject";--> statement-breakpoint
ALTER TABLE "approval_runs" DROP CONSTRAINT "approval_runs_subject_type";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "signatures" DROP CONSTRAINT "signatures_subject_type";--> statement-breakpoint
DROP INDEX "approval_routes_one_active";--> statement-breakpoint
ALTER TABLE "approval_routes" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "risk_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "action_id" uuid;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_action_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_actor_fk" FOREIGN KEY ("tenant_id","actor_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_notes" ADD CONSTRAINT "action_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_notes" ADD CONSTRAINT "action_notes_action_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_notes" ADD CONSTRAINT "action_notes_written_by_fk" FOREIGN KEY ("tenant_id","written_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_notes" ADD CONSTRAINT "action_notes_corrected_by_fk" FOREIGN KEY ("tenant_id","corrected_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_reminders" ADD CONSTRAINT "action_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_reminders" ADD CONSTRAINT "action_reminders_action_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_org_unit_fk" FOREIGN KEY ("tenant_id","org_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_completed_by_fk" FOREIGN KEY ("tenant_id","completed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_verified_by_fk" FOREIGN KEY ("tenant_id","verified_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_rating_fk" FOREIGN KEY ("tenant_id","rating_id") REFERENCES "public"."risk_ratings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."risk_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_run_fk" FOREIGN KEY ("tenant_id","approval_run_id") REFERENCES "public"."approval_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_bands" ADD CONSTRAINT "risk_bands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_bands" ADD CONSTRAINT "risk_bands_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."risk_matrices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_bands" ADD CONSTRAINT "risk_bands_committee_fk" FOREIGN KEY ("tenant_id","escalate_to_committee_id") REFERENCES "public"."risk_committees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_categories" ADD CONSTRAINT "risk_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_committees" ADD CONSTRAINT "risk_committees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_committees" ADD CONSTRAINT "risk_committees_member_role_fk" FOREIGN KEY ("tenant_id","member_role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_committees" ADD CONSTRAINT "risk_committees_chair_role_fk" FOREIGN KEY ("tenant_id","chair_role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_controls" ADD CONSTRAINT "risk_controls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_controls" ADD CONSTRAINT "risk_controls_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_controls" ADD CONSTRAINT "risk_controls_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_controls" ADD CONSTRAINT "risk_controls_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_controls" ADD CONSTRAINT "risk_controls_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_actor_fk" FOREIGN KEY ("tenant_id","actor_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_impact_domains" ADD CONSTRAINT "risk_impact_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_impact_domains" ADD CONSTRAINT "risk_impact_domains_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."risk_matrices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incident_links" ADD CONSTRAINT "risk_incident_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incident_links" ADD CONSTRAINT "risk_incident_links_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incident_links" ADD CONSTRAINT "risk_incident_links_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incident_links" ADD CONSTRAINT "risk_incident_links_linked_by_fk" FOREIGN KEY ("tenant_id","linked_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incident_links" ADD CONSTRAINT "risk_incident_links_removed_by_fk" FOREIGN KEY ("tenant_id","removed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrices" ADD CONSTRAINT "risk_matrices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrices" ADD CONSTRAINT "risk_matrices_put_in_use_by_fk" FOREIGN KEY ("tenant_id","put_in_use_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrices" ADD CONSTRAINT "risk_matrices_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrix_cells" ADD CONSTRAINT "risk_matrix_cells_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrix_cells" ADD CONSTRAINT "risk_matrix_cells_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."risk_matrices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrix_cells" ADD CONSTRAINT "risk_matrix_cells_band_fk" FOREIGN KEY ("tenant_id","matrix_id","band_code") REFERENCES "public"."risk_bands"("tenant_id","matrix_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrix_levels" ADD CONSTRAINT "risk_matrix_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_matrix_levels" ADD CONSTRAINT "risk_matrix_levels_matrix_fk" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."risk_matrices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_notes" ADD CONSTRAINT "risk_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_notes" ADD CONSTRAINT "risk_notes_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_notes" ADD CONSTRAINT "risk_notes_written_by_fk" FOREIGN KEY ("tenant_id","written_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_notes" ADD CONSTRAINT "risk_notes_corrected_by_fk" FOREIGN KEY ("tenant_id","corrected_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_ratings" ADD CONSTRAINT "risk_ratings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_ratings" ADD CONSTRAINT "risk_ratings_review_fk" FOREIGN KEY ("tenant_id","review_id") REFERENCES "public"."risk_reviews"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_ratings" ADD CONSTRAINT "risk_ratings_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_ratings" ADD CONSTRAINT "risk_ratings_cell_fk" FOREIGN KEY ("tenant_id","matrix_id","likelihood","impact","band_code") REFERENCES "public"."risk_matrix_cells"("tenant_id","matrix_id","likelihood","impact","band_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_ratings" ADD CONSTRAINT "risk_ratings_rated_by_fk" FOREIGN KEY ("tenant_id","rated_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_reminders" ADD CONSTRAINT "risk_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_reviews" ADD CONSTRAINT "risk_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_reviews" ADD CONSTRAINT "risk_reviews_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_reviews" ADD CONSTRAINT "risk_reviews_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_reviews" ADD CONSTRAINT "risk_reviews_committee_fk" FOREIGN KEY ("tenant_id","committee_id") REFERENCES "public"."risk_committees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_settings" ADD CONSTRAINT "risk_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_settings" ADD CONSTRAINT "risk_settings_framework_document_fk" FOREIGN KEY ("tenant_id","framework_document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_settings" ADD CONSTRAINT "risk_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_org_unit_fk" FOREIGN KEY ("tenant_id","org_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."risk_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_rejected_by_fk" FOREIGN KEY ("tenant_id","rejected_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_committee_fk" FOREIGN KEY ("tenant_id","escalated_to_committee_id") REFERENCES "public"."risk_committees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_merged_into_fk" FOREIGN KEY ("tenant_id","merged_into_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_closure_requested_by_fk" FOREIGN KEY ("tenant_id","closure_requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_inherent_cell_fk" FOREIGN KEY ("tenant_id","inherent_matrix_id","inherent_likelihood","inherent_impact","inherent_band") REFERENCES "public"."risk_matrix_cells"("tenant_id","matrix_id","likelihood","impact","band_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_current_cell_fk" FOREIGN KEY ("tenant_id","current_matrix_id","current_likelihood","current_impact","current_band") REFERENCES "public"."risk_matrix_cells"("tenant_id","matrix_id","likelihood","impact","band_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_target_cell_fk" FOREIGN KEY ("tenant_id","target_matrix_id","target_likelihood","target_impact","target_band") REFERENCES "public"."risk_matrix_cells"("tenant_id","matrix_id","likelihood","impact","band_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_events_action_idx" ON "action_events" USING btree ("tenant_id","action_id","occurred_at");--> statement-breakpoint
CREATE INDEX "action_notes_action_idx" ON "action_notes" USING btree ("tenant_id","action_id");--> statement-breakpoint
CREATE INDEX "actions_risk_idx" ON "actions" USING btree ("tenant_id","risk_id");--> statement-breakpoint
CREATE INDEX "actions_owner_idx" ON "actions" USING btree ("tenant_id","owner_id","status");--> statement-breakpoint
CREATE INDEX "actions_due_idx" ON "actions" USING btree ("tenant_id","status","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_acceptances_one_open" ON "risk_acceptances" USING btree ("tenant_id","risk_id") WHERE "risk_acceptances"."status" in ('in_approval', 'accepted');--> statement-breakpoint
CREATE INDEX "risk_controls_risk_idx" ON "risk_controls" USING btree ("tenant_id","risk_id");--> statement-breakpoint
CREATE INDEX "risk_events_risk_idx" ON "risk_events" USING btree ("tenant_id","risk_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_incident_links_one_live" ON "risk_incident_links" USING btree ("tenant_id","risk_id","incident_id") WHERE "risk_incident_links"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "risk_incident_links_incident_idx" ON "risk_incident_links" USING btree ("tenant_id","incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_matrices_one_in_use" ON "risk_matrices" USING btree ("tenant_id") WHERE "risk_matrices"."status" = 'in_use';--> statement-breakpoint
CREATE UNIQUE INDEX "risk_matrices_one_draft" ON "risk_matrices" USING btree ("tenant_id") WHERE "risk_matrices"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "risk_notes_risk_idx" ON "risk_notes" USING btree ("tenant_id","risk_id");--> statement-breakpoint
CREATE INDEX "risk_ratings_risk_idx" ON "risk_ratings" USING btree ("tenant_id","risk_id","rated_at");--> statement-breakpoint
CREATE INDEX "risk_reviews_risk_idx" ON "risk_reviews" USING btree ("tenant_id","risk_id","reviewed_on");--> statement-breakpoint
CREATE INDEX "risks_status_idx" ON "risks" USING btree ("tenant_id","status","current_score");--> statement-breakpoint
CREATE INDEX "risks_org_unit_idx" ON "risks" USING btree ("tenant_id","org_unit_id");--> statement-breakpoint
CREATE INDEX "risks_owner_idx" ON "risks" USING btree ("tenant_id","owner_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_risk_fk" FOREIGN KEY ("tenant_id","risk_id") REFERENCES "public"."risks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_action_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_routes_one_active" ON "approval_routes" USING btree ("tenant_id","subject",coalesce("document_type_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("variant", '')) WHERE "approval_routes"."active";--> statement-breakpoint
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_subject_fields" CHECK (("approval_routes"."subject" = 'document' or "approval_routes"."document_type_id" is null)
        and (("approval_routes"."subject" = 'risk_acceptance') = ("approval_routes"."variant" is not null))
        and ("approval_routes"."variant" is null or "approval_routes"."variant" in ('medium', 'high', 'extreme')));--> statement-breakpoint
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_subject" CHECK ("approval_routes"."subject" in ('document', 'risk_acceptance', 'risk_closure'));--> statement-breakpoint
ALTER TABLE "approval_runs" ADD CONSTRAINT "approval_runs_subject_type" CHECK ("approval_runs"."subject_type" in ('document_version', 'risk_acceptance', 'risk'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (num_nonnulls("notifications"."incident_id", "notifications"."document_id", "notifications"."risk_id", "notifications"."action_id") <= 1 and (num_nonnulls("notifications"."incident_id", "notifications"."document_id", "notifications"."risk_id", "notifications"."action_id") = 1 or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed', 'signing_pin_locked', 'review_approval_turned_off', 'audit_chain_broken', 'policies_import_granted', 'external_access_changed', 'audit_chain_head', 'data_export_changed', 'ai_provider_changed', 'ai_allowance_warning', 'ai_allowance_reached', 'contract_ending', 'data_export_granted', 'risks_overdue_digest')));--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_subject_type" CHECK ("signatures"."subject_type" in ('document_version', 'document', 'risk_acceptance', 'risk'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "action_events" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "action_notes" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "action_reminders" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "actions" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_acceptances" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_bands" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_categories" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_committees" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_controls" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_events" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_impact_domains" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_incident_links" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_matrices" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_matrix_cells" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_matrix_levels" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_notes" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_ratings" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_reminders" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_reviews" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risk_settings" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "risks" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);