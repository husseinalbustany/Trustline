/**
 * Loads a page from scratch. Used when a session starts or ends: Next.js
 * keeps visited pages mounted, and a full load is the only way to be sure
 * nothing from the previous user's session is still in the page.
 */
export function loadPage(path: string) {
  window.location.assign(path);
}

/** The query parameter that carries the page asked for to the sign-in page. */
const RETURN = "next";

/**
 * The sign-in page, told which page was asked for: the one this tab is on.
 * Used when a page finds there is no session, not when someone signs out.
 */
export function signInFor(loginPath: string) {
  const asked = `${window.location.pathname}${window.location.search}`;
  return `${loginPath}?${new URLSearchParams({ [RETURN]: asked })}`;
}

/**
 * Where to go once signed in: the page the sign-in page was told of, when
 * it is a page of this app in this language (under `area`, outside each of
 * `except`), and `fallback` otherwise. Anything else is ignored, so the
 * sign-in page cannot be used to send someone to another site: only a path
 * that starts with one `/` is taken, with no `//`, no backslash (which
 * browsers read as a slash), no scheme, nothing invisible, and the same
 * origin once read as an address.
 */
export function returnPath(
  area: string,
  except: string[],
  fallback: string,
): string {
  const asked = new URLSearchParams(window.location.search).get(RETURN);
  if (
    !asked ||
    asked.length > 2000 ||
    !asked.startsWith("/") ||
    asked.includes("//") ||
    asked.includes("\\") ||
    // A colon before any query: a scheme, wherever it is put.
    /^[^?#]*:/.test(asked) ||
    // Spaces, line breaks and control characters, which a path never has.
    /[\s\x00-\x1f\x7f-\x9f]/.test(asked)
  ) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(asked, window.location.origin);
  } catch {
    return fallback;
  }
  // `..` and its encoded forms are resolved by now: what is checked is the
  // page the browser would open.
  const under = (base: string) =>
    url.pathname === base || url.pathname.startsWith(`${base}/`);
  if (
    url.origin !== window.location.origin ||
    !under(area) ||
    except.some(under)
  ) {
    return fallback;
  }
  return `${url.pathname}${url.search}`;
}
