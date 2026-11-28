"use client";

import { useCallback } from "react";
import { useSubscriptionRefusal } from "@/components/shell/subscription";
import { dayFormat, numberFormat } from "@/lib/format";
import { explain, type RisksText } from "./types";

/**
 * The words for a refusal on a risk screen: the subscription's own first,
 * then the module's, with days and numbers as the reader writes them.
 */
export function useExplain(t: RisksText, lang: string) {
  const refusal = useSubscriptionRefusal();
  return useCallback(
    (err: unknown) =>
      refusal(err) ??
      explain(err, t, {
        day: (value) => dayFormat(lang)(value) ?? value,
        count: (value) => numberFormat(lang).format(value),
      }),
    [refusal, t, lang],
  );
}
