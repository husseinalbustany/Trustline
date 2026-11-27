import { CalendarClock, Lock } from "lucide-react";
import { Pill } from "@/components/ui/pill";
import type {
  DocumentStatus,
  ReviewState,
  VersionStatus,
} from "@/lib/policies";
import type { PoliciesText } from "./types";

const documentTone = {
  draft: "neutral",
  active: "ok",
  retired: "neutral",
} as const;

export function DocumentStatusPill({
  t,
  status,
}: {
  t: PoliciesText;
  status: DocumentStatus;
}) {
  return <Pill tone={documentTone[status] ?? "neutral"}>{t.status[status]}</Pill>;
}

const versionTone: Record<string, "ok" | "warn" | "neutral"> = {
  draft: "neutral",
  in_review: "warn",
  approved: "ok",
  published: "ok",
  superseded: "neutral",
  withdrawn: "neutral",
};

export const versionStatusWord = (t: PoliciesText, status: VersionStatus) =>
  Object.hasOwn(t.versionStatus, status)
    ? t.versionStatus[status as keyof typeof t.versionStatus]
    : t.versionStatus.other;

export function VersionStatusPill({
  t,
  status,
}: {
  t: PoliciesText;
  status: VersionStatus;
}) {
  return (
    <Pill tone={versionTone[status] ?? "neutral"}>
      {versionStatusWord(t, status)}
    </Pill>
  );
}

/** Due or overdue for its periodic review: in words, with an icon. */
export function ReviewPill({
  t,
  review,
}: {
  t: PoliciesText;
  review: ReviewState;
}) {
  if (!review) return null;
  return (
    <Pill
      tone={review === "overdue" ? "danger" : "warn"}
      icon={<CalendarClock className="size-3 shrink-0" aria-hidden />}
    >
      {t.reviewState[review]}
    </Pill>
  );
}

export function RestrictedPill({ t }: { t: PoliciesText }) {
  return (
    <Pill
      tone="neutral"
      icon={<Lock className="size-3 shrink-0" aria-hidden />}
    >
      {t.confidentiality.restricted}
    </Pill>
  );
}
