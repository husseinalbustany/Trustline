import { notFound } from "next/navigation";
import { hasLocale, type Locale } from "./config";

export type LangParams = Promise<{ lang: string }>;

/** Reads the locale from a route's params, or renders not-found. */
export async function resolveLocale(params: LangParams): Promise<Locale> {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  return lang;
}
