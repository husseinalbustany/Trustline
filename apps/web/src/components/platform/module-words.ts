import { moduleCodes, moduleRules, type ModuleCode } from "@/config/modules";
import type { Dictionary } from "@/i18n/dictionaries";
import { codeOf, detailsOf } from "@/lib/api";
import { fill } from "@/lib/format";

export type ModuleNames = Dictionary["moduleNames"];

/** The names of modules as one phrase: "Incidents or Policies". */
export function moduleList(
  lang: string,
  names: ModuleNames,
  modules: readonly string[],
  type: "conjunction" | "disjunction" = "conjunction",
) {
  const known = modules.filter((m): m is ModuleCode =>
    (moduleCodes as readonly string[]).includes(m),
  );
  return new Intl.ListFormat(lang, { type }).format(known.map((m) => names[m]));
}

/** What a module needs, in words; null when it stands on core alone. */
export function needsText(
  lang: string,
  names: ModuleNames,
  words: { needs: string; needsAnyOther: string },
  module: ModuleCode,
) {
  const { requiresAnyOf } = moduleRules[module];
  if (requiresAnyOf.length === 0) return null;
  // "Any other module" said as such, not as a list of six.
  if (requiresAnyOf.length >= moduleCodes.length - 1)
    return words.needsAnyOther;
  return fill(words.needs, {
    modules: moduleList(lang, names, requiresAnyOf, "disjunction"),
  });
}

/**
 * The refusal `module_dependency_missing` in words: which module, and what
 * it needs; with `tenantId`, that it is a client's add-on that would lose
 * what it needs. Null for any other answer.
 */
export function dependencyRefusal(
  err: unknown,
  lang: string,
  names: ModuleNames,
  words: {
    dependency: string;
    dependencyAnyOther: string;
    clientDependency: string;
  },
) {
  if (codeOf(err) !== "module_dependency_missing") return null;
  const { module, requiresAnyOf, tenantId } = detailsOf(err);
  const name =
    typeof module === "string" &&
    (moduleCodes as readonly string[]).includes(module)
      ? names[module as ModuleCode]
      : String(module ?? "");
  const needed = Array.isArray(requiresAnyOf)
    ? requiresAnyOf.filter((m): m is string => typeof m === "string")
    : [];
  const requires =
    needed.length >= moduleCodes.length - 1
      ? null
      : moduleList(lang, names, needed, "disjunction");
  if (tenantId) return fill(words.clientDependency, { module: name });
  return requires
    ? fill(words.dependency, { module: name, requires })
    : fill(words.dependencyAnyOther, { module: name });
}
