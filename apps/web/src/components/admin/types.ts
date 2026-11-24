import type { Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";

export type AdminText = Dictionary["admin"];
export type AdminProps = { lang: Locale; t: AdminText };
