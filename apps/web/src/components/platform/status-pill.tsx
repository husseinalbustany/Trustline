import type { Client } from "@/lib/platform-api";

export function StatusPill({
  status,
  label,
}: {
  status: Client["status"];
  label: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
        status === "active"
          ? "bg-accent-soft text-accent"
          : "bg-danger-soft text-danger"
      }`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}
