import { TriangleAlert } from "lucide-react";
import { Pill } from "@/components/ui/pill";
import {
  harmTone,
  statusToneOf,
  wordFor,
  type HarmLevel,
  type IncidentStatus,
} from "@/lib/incidents";
import type { IncidentsText } from "./types";

const warning = <TriangleAlert className="size-3 shrink-0" aria-hidden />;

/**
 * Status, harm level and the sentinel mark, always in words. Severe harm, a
 * death and a sentinel event are solid and carry a warning sign, so they
 * stand out from everything else in a list.
 */
export function IncidentPills({
  t,
  status,
  harmLevel,
  isSentinel,
}: {
  t: IncidentsText;
  status: IncidentStatus;
  harmLevel: HarmLevel;
  isSentinel: boolean;
}) {
  const tone = harmTone[harmLevel];
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Pill tone={statusToneOf(status)}>
        {wordFor(t.status, status, t.statusOther)}
      </Pill>
      <Pill tone={tone} icon={tone === "alert" ? warning : undefined}>
        {t.harm[harmLevel]}
      </Pill>
      {isSentinel && (
        <Pill tone="alert" icon={warning}>
          {t.sentinel}
        </Pill>
      )}
    </span>
  );
}
