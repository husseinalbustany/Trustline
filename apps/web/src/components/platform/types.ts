import type { Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";

export type PlatformText = Dictionary["platform"];
export type PlatformProps = { lang: Locale; t: PlatformText };
