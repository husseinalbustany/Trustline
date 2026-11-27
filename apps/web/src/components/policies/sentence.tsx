import { Fragment, type ReactNode } from "react";
import { fill } from "@/lib/format";

/**
 * A sentence from the dictionary with values that are pieces of the page,
 * not only words: a date and time that must not wrap between them. Text
 * values are isolated as `fill` isolates them; a piece is put in a `<bdi>`.
 */
export function Words({
  text,
  values,
}: {
  text: string;
  values: Record<string, string | number | ReactNode>;
}) {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!key || !(key in values)) return <Fragment key={i}>{part}</Fragment>;
    const value = values[key];
    return typeof value === "string" || typeof value === "number" ? (
      <Fragment key={i}>{`⁨${value}⁩`}</Fragment>
    ) : (
      <bdi key={i}>{value}</bdi>
    );
  });
}

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
