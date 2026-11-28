import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { SubmitRefusal } from "./use-submit-refusal";

/**
 * A refused "send for review": an error in red, or, when nobody can decide
 * a step yet, a plain warning saying what to do, with the way there.
 */
export function RefusalNote({ refusal }: { refusal: SubmitRefusal }) {
  if (!refusal.warning) {
    return (
      <p role="alert" className="text-sm text-danger">
        {refusal.text}
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div className="flex flex-col gap-1">
        <p>{refusal.text}</p>
        {refusal.link && (
          <p>
            <Link href={refusal.link.href} className="font-medium text-accent hover:underline">
              {refusal.link.label}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
