import { fill } from "@/lib/format";

/**
 * A sentence from the dictionary that names a document's number: the
 * number is one piece, left to right and never broken at its hyphens, so
 * it does not wrap as "PRC-SAF-" and "014", nor have its parts reordered
 * in a right-to-left sentence.
 */
export function Sentence({
  text,
  number,
  values = {},
}: {
  text: string;
  number: string;
  values?: Record<string, string | number>;
}) {
  return fill(text, values)
    .split("{number}")
    .flatMap((words, i) =>
      i === 0
        ? [words]
        : [
            <bdi key={i} dir="ltr" className="whitespace-nowrap">
              {number}
            </bdi>,
            words,
          ],
    );
}
