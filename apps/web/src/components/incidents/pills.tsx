import { Pill } from "@/components/ui/pill";
import {
  harmTone,
  statusTone,
  type HarmLevel,
  type IncidentStatus,
} from "@/lib/incidents";
import type { IncidentsText } from "./types";

/** Status, harm level and the sentinel mark, always in words. */
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
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Pill tone={statusTone[status]}>{t.status[status]}</Pill>
      <Pill tone={harmTone[harmLevel]}>{t.harm[harmLevel]}</Pill>
      {isSentinel && <Pill tone="danger">{t.sentinel}</Pill>}
    </span>
  );
}
