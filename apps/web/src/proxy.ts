import { NextResponse, type NextRequest } from "next/server";
import { defaultLocale, hasLocale, type Locale } from "./i18n/config";

function preferredLocale(request: NextRequest): Locale {
  const header = request.headers.get("accept-language") ?? "";
  for (const part of header.split(",")) {
    const language = part.split(";")[0].trim().split("-")[0].toLowerCase();
    if (hasLocale(language)) return language;
  }
  return defaultLocale;
}

// Every page lives under /en or /ar. Requests without a locale are redirected
// to the one the browser prefers.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (hasLocale(pathname.split("/")[1] ?? "")) return;

  request.nextUrl.pathname = `/${preferredLocale(request)}${pathname}`;
  return NextResponse.redirect(request.nextUrl);
}

export const config = {
  // Skip the API, Next.js internals and files with an extension (favicon.ico).
  matcher: ["/((?!api/|_next|.*\\..*).*)"],
};
