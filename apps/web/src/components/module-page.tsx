import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { navItems, type PlaceholderKey } from "@/config/navigation";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

/**
 * The page a module shows until it is built: what it is for and what it will
 * cover. Each module replaces this with its real screens.
 */
export async function ModulePage({
  params,
  module,
}: {
  params: LangParams;
  module: PlaceholderKey;
}) {
  const dict = await getDictionary(await resolveLocale(params));
  const content = dict.modules[module];
  const phase = navItems.find((item) => item.key === module)?.phase;

  return (
    <>
      <PageHeader
        title={content.title}
        description={content.description}
        actions={phase === 2 && <Badge>{dict.shell.phase2}</Badge>}
      />
      <div className="mt-6 max-w-2xl">
        <Panel title={dict.modulePage.scopeTitle}>
          <ul className="space-y-3 p-4">
            {content.scope.map((line) => (
              <li key={line} className="flex gap-3 text-sm">
                <Check
                  className="mt-0.5 size-4 shrink-0 text-accent"
                  aria-hidden
                />
                {line}
              </li>
            ))}
          </ul>
        </Panel>
        <p className="mt-4 text-sm text-muted">{dict.modulePage.notBuilt}</p>
      </div>
    </>
  );
}
