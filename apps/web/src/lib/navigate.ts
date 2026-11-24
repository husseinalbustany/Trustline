/**
 * Loads a page from scratch. Used when a session starts or ends: Next.js
 * keeps visited pages mounted, and a full load is the only way to be sure
 * nothing from the previous user's session is still in the page.
 */
export function loadPage(path: string) {
  window.location.assign(path);
}
