"use client";

import { useCallback } from "react";
import { useSession } from "@/components/shell/session";
import { useSubscriptionRefusal } from "@/components/shell/subscription";
import { hasLocale, localeNames } from "@/i18n/config";
import { pick } from "@/lib/localized";
import type { Section } from "@/lib/policies";
import { explain, type PoliciesText } from "./types";

/**
 * The words for a refusal on a screen of this module: the subscription's
 * own first, then the module's, naming the section and the language a
 * refusal is about.
 */
export function useExplain(
  t: PoliciesText,
  lang: string,
  sections: Section[] = [],
) {
  const session = useSession();
  const refusal = useSubscriptionRefusal();
  return useCallback(
    (err: unknown) =>
      refusal(err) ??
      explain(err, t, {
        section: (key) => {
          const found = sections.find((s) => s.key === key);
          return found
            ? pick(found.name, lang, session.tenant.defaultLocale)
            : key;
        },
        language: (locale) =>
          hasLocale(locale) ? localeNames[locale] : locale,
      }),
    [refusal, t, sections, lang, session.tenant.defaultLocale],
  );
}
