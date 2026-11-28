"use client";

import { useCallback } from "react";
import { can, useSession } from "@/components/shell/session";
import { api, codeOf, detailsOf } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import { pick } from "@/lib/localized";
import type { ApprovalRoute, PolicyDocument, Section } from "@/lib/policies";
import type { PoliciesText } from "./types";
import { useExplain } from "./use-explain";

/** What to say when sending a version for review is refused, and where to go next. */
export type SubmitRefusal = {
  text: string;
  /** Nobody can decide a step yet: a warning, not an error, with what to do. */
  warning: boolean;
  /** Where the people who may fix it do so, when the reader may. */
  link: { href: string; label: string } | null;
};

/**
 * The words for a refusal of "send for review". When a step of the route
 * has nobody who can decide it (`no_assignee`), the step is named from the
 * route, with what to do: for a role nobody holds yet (the Approving
 * authority, after it was added), give it to someone.
 */
export function useSubmitRefusal(
  t: PoliciesText,
  lang: string,
  doc: Pick<PolicyDocument, "type">,
  sections: Section[] = [],
) {
  const session = useSession();
  const explainError = useExplain(t, lang, sections);
  return useCallback(
    async (err: unknown): Promise<SubmitRefusal> => {
      const plain = { text: explainError(err), warning: false, link: null };
      if (codeOf(err) !== "no_assignee") return plain;
      const position = Number(detailsOf(err).position);
      const routes = await api<ApprovalRoute[]>("/policies/approval-routes").catch(
        () => null,
      );
      const route =
        routes?.find((r) => r.active && r.documentTypeId === doc.type.id) ??
        routes?.find((r) => r.active && r.documentTypeId === null);
      const step = route?.steps.find((s) => s.position === position);
      const e = t.errors;
      if (!step) return { ...plain, warning: true };
      const values = {
        position: numberFormat(lang).format(position),
        kind: t.stepKind[step.kind] ?? step.kind,
      };
      if (step.assignee.type === "role") {
        const fixes = can(session, "users.manage");
        return {
          // Whoever can give the role is told to, not to ask someone else.
          text: fill(fixes ? e.no_assignee_role_manager : e.no_assignee_role, {
            ...values,
            role: pick(step.assignee.role.name, lang, session.tenant.defaultLocale),
          }),
          warning: true,
          link: fixes
            ? { href: `/${lang}/admin/users`, label: e.no_assignee_give_role }
            : null,
        };
      }
      const changesRoutes = session.scope?.["policies.manage"] === "all";
      return {
        text: fill(changesRoutes ? e.no_assignee_person_manager : e.no_assignee_person, {
          ...values,
          name:
            pick(step.assignee.user?.name, lang, session.tenant.defaultLocale) ||
            t.document.unknownPerson,
        }),
        warning: true,
        link:
          changesRoutes
            ? { href: `/${lang}/policies/settings?tab=routes`, label: e.no_assignee_open_routes }
            : null,
      };
    },
    [explainError, doc.type.id, t, lang, session],
  );
}
