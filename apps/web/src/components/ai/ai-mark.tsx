import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The AI mark: a small spark and "AI draft" or "AI suggestion", in the AI
 * colour, which nothing else uses (design guidelines, "AI content").
 */
export function AiMark({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-ai px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ai">
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}

/**
 * A panel of AI content: its own edge in the AI colour, its mark, and the
 * fixed notice, never mixed into the record beside it.
 */
export function AiPanel({
  mark,
  notice,
  children,
}: {
  mark: string;
  notice: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line border-s-4 border-s-ai bg-background p-4">
      <div className="flex flex-col gap-2">
        <AiMark>{mark}</AiMark>
        <p className="text-sm text-muted">{notice}</p>
      </div>
      {children}
    </section>
  );
}
