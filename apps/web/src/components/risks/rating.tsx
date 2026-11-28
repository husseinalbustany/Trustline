"use client";

import { useState } from "react";
import { useSession } from "@/components/shell/session";
import { LocalizedField } from "@/components/ui/localized-field";
import { fill, numberFormat } from "@/lib/format";
import type { Localized } from "@/lib/localized";
import {
  bandAt,
  bandCell,
  type Band,
  type Matrix,
  type Rating,
  type RatingInput,
  type RatingKind,
} from "@/lib/risks";
import { BandPill, usePick } from "./bits";
import type { RisksText } from "./types";

/** What a rating picker put in the form, or null when nothing was picked. */
export function readRating(
  data: FormData,
  prefix: string,
  locales: string[],
): RatingInput | null {
  const likelihood = Number(data.get(`${prefix}Likelihood`));
  const impact = Number(data.get(`${prefix}Impact`));
  if (!likelihood || !impact) return null;
  const rationale: Localized = {};
  for (const locale of locales) {
    const value = String(data.get(`${prefix}Rationale.${locale}`) ?? "").trim();
    if (value) rationale[locale] = value;
  }
  return {
    likelihood,
    impact,
    rationale: Object.keys(rationale).length > 0 ? rationale : null,
  };
}

/**
 * The rating dialog's content: one card per level of each axis, with its
 * label and descriptor, the impact domains as a table, the score and band
 * as they follow from the matrix, and a rationale. It sits inside the form
 * that sends it, under names starting with `prefix`.
 */
export function RatingPicker({
  t,
  lang,
  matrix,
  prefix,
  initial,
  word,
  withRationale = true,
  heading,
}: {
  t: RisksText;
  lang: string;
  matrix: Matrix;
  prefix: string;
  initial?: Pick<Rating, "likelihood" | "impact"> | null;
  word: (band: Band) => string;
  withRationale?: boolean;
  /** The rating's kind, said above it. */
  heading?: string;
}) {
  const session = useSession();
  const inLang = usePick(lang);
  const numbers = numberFormat(lang);
  const [likelihood, setLikelihood] = useState(
    initial && initial.likelihood <= matrix.likelihoodLevels ? initial.likelihood : 0,
  );
  const [impact, setImpact] = useState(
    initial && initial.impact <= matrix.impactLevels ? initial.impact : 0,
  );
  const band = likelihood && impact ? bandAt(matrix, likelihood, impact) : null;
  const domains = matrix.domains.filter((d) => d.active);
  const r = t.rating;

  const card =
    "flex min-h-11 cursor-pointer gap-2 rounded-md border border-line bg-background p-2.5 text-sm has-checked:border-accent has-checked:bg-accent-soft has-focus-visible:ring-2 has-focus-visible:ring-accent";
  const axis = (
    which: "likelihood" | "impact",
    value: number,
    set: (n: number) => void,
  ) => (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-medium">{t.axis[which]}</legend>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {matrix[which].map((level) => (
          <label key={level.level} className={card}>
            <input
              type="radio"
              name={`${prefix}${which === "likelihood" ? "Likelihood" : "Impact"}`}
              value={level.level}
              checked={value === level.level}
              onChange={() => set(level.level)}
              required
              className="mt-0.5 accent-accent"
            />
            <span className="min-w-0">
              <span className="font-medium">
                <span className="tabular-nums">{numbers.format(level.level)}</span>{" "}
                <bdi>{inLang(level.label)}</bdi>
              </span>
              {level.frequency && (
                <span dir="auto" className="block text-xs text-muted">
                  {inLang(level.frequency)}
                </span>
              )}
              {level.descriptor && (
                <span dir="auto" className="block text-xs text-muted">
                  {inLang(level.descriptor)}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="flex flex-col gap-4">
      {heading && <h3 className="text-sm font-semibold">{heading}</h3>}
      <div className="grid gap-4 lg:grid-cols-2">
        {axis("likelihood", likelihood, setLikelihood)}
        {axis("impact", impact, setImpact)}
      </div>

      {domains.length > 0 && (
        <details className="rounded-md border border-line bg-background">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            {r.domains}
          </summary>
          <p className="px-3 text-xs text-muted">{r.domainsHint}</p>
          <div className="mt-2 overflow-x-auto px-3 pb-3">
            <table className="w-full min-w-[40rem] border-collapse text-xs">
              <thead>
                <tr>
                  <th scope="col" className="border border-line p-1.5 text-start font-medium">
                    {r.domain}
                  </th>
                  {matrix.impact.map((level) => (
                    <th
                      key={level.level}
                      scope="col"
                      className={`border border-line p-1.5 text-start font-medium ${impact === level.level ? "bg-accent-soft" : ""}`}
                    >
                      <span className="tabular-nums">{numbers.format(level.level)}</span>{" "}
                      <bdi>{inLang(level.label)}</bdi>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => (
                  <tr key={domain.id}>
                    <th scope="row" className="border border-line p-1.5 text-start font-medium">
                      <bdi>{inLang(domain.name)}</bdi>
                    </th>
                    {matrix.impact.map((level) => (
                      <td
                        key={level.level}
                        dir="auto"
                        className={`border border-line p-1.5 align-top ${impact === level.level ? "bg-accent-soft" : ""}`}
                      >
                        {inLang(domain.descriptors[String(level.level)])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
        {band ? (
          <>
            {fill(r.result, {
              likelihood: numbers.format(likelihood),
              impact: numbers.format(impact),
            })}
            <BandPill band={band} score={likelihood * impact} word={word} lang={lang} />
          </>
        ) : (
          <span className="text-muted">{r.pick}</span>
        )}
      </p>

      {withRationale && (
        <LocalizedField
          label={r.rationale}
          name={`${prefix}Rationale`}
          locales={session.tenant.locales}
          multiline
          maxLength={1000}
        />
      )}
    </div>
  );
}

/**
 * The matrix in use, small, with where the risk's ratings fall: likelihood
 * rows highest at the top, impact columns lowest at the inline start, so
 * it mirrors in Arabic. Each cell is named for screen readers.
 */
export function MatrixGrid({
  t,
  lang,
  matrix,
  ratings,
  word,
}: {
  t: RisksText;
  lang: string;
  matrix: Matrix;
  ratings: Partial<Record<RatingKind, Rating | null>>;
  word: (band: Band) => string;
}) {
  const inLang = usePick(lang);
  const numbers = numberFormat(lang);
  const kinds = (["inherent", "current", "target"] as const).filter((k) => ratings[k]);
  const rows = [...matrix.likelihood].reverse();
  return (
    <figure className="min-w-0">
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">
          <caption className="sr-only">{t.matrix.caption}</caption>
          <thead>
            <tr>
              <td />
              {matrix.impact.map((level) => (
                <th
                  key={level.level}
                  scope="col"
                  title={inLang(level.label)}
                  className="w-12 p-1 text-center font-normal text-muted"
                >
                  <span className="tabular-nums">{numbers.format(level.level)}</span>
                  <span className="sr-only"> {inLang(level.label)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.level}>
                <th
                  scope="row"
                  title={inLang(row.label)}
                  className="pe-2 text-end font-normal text-muted"
                >
                  <span className="tabular-nums">{numbers.format(row.level)}</span>
                  <span className="sr-only"> {inLang(row.label)}</span>
                </th>
                {matrix.impact.map((col) => {
                  const band = bandAt(matrix, row.level, col.level) ?? "low";
                  const here = kinds.filter(
                    (k) =>
                      ratings[k]?.likelihood === row.level &&
                      ratings[k]?.impact === col.level,
                  );
                  return (
                    <td
                      key={col.level}
                      className={`h-10 w-12 border border-background p-0.5 text-center align-middle ${bandCell[band]}`}
                    >
                      <span className="sr-only">
                        {fill(t.matrix.cell, {
                          band: word(band),
                          score: numbers.format(row.level * col.level),
                        })}
                        {here.length > 0 && ` ${here.map((k) => t.ratingKind[k]).join(", ")}`}
                      </span>
                      <span aria-hidden className="flex flex-wrap justify-center gap-0.5 font-semibold">
                        {here.map((k) => (
                          <span
                            key={k}
                            className="rounded-sm bg-background px-1 text-foreground ring-1 ring-foreground"
                          >
                            {t.matrix.mark[k]}
                          </span>
                        ))}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          {t.matrix.axes}
        </span>
        {kinds.map((k) => (
          <span key={k}>
            <span className="rounded-sm px-1 font-semibold text-foreground ring-1 ring-foreground">
              {t.matrix.mark[k]}
            </span>{" "}
            {t.ratingKind[k]}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
