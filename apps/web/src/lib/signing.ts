import { api, codeOf, statusOf } from "@/lib/api";
import { loadPage, signInFor } from "@/lib/navigate";

/** Why the sign-in page is shown again: said there in a sentence. */
export const signedOutReasons = ["ended", "pinLocked"] as const;
export type SignedOutReason = (typeof signedOutReasons)[number];

/** The query parameter that carries the reason to the sign-in page. */
export const SIGNED_OUT = "signedOut";

/** The reason a sign-in page's address gives, when it is one of ours. */
export function signedOutReasonIn(search: string): SignedOutReason | null {
  const asked = new URLSearchParams(search).get(SIGNED_OUT);
  return signedOutReasons.find((r) => r === asked) ?? null;
}

/**
 * To the sign-in page, saying why, and back to this page once signed in.
 * A full page load, so nothing of the ended session stays mounted.
 */
export function signInAgain(lang: string, reason: SignedOutReason) {
  const to = signInFor(`/${lang}/login`);
  loadPage(`${to}&${new URLSearchParams({ [SIGNED_OUT]: reason })}`);
}

/**
 * After a signature refused, what the session became (security review 11):
 * - `"gone"`: the session has ended (the 10th wrong PIN signs it out, and
 *   an administrator's reset signs the person out everywhere), and the
 *   page is on its way to the sign-in page;
 * - `"locked"`: signing with the PIN is locked, but this session stands;
 * - `null`: anything else, said as the screen says it.
 */
export async function afterSigningRefusal(
  err: unknown,
  lang: string,
): Promise<"gone" | "locked" | null> {
  const code = codeOf(err);
  if (code === "signing_pin_locked") {
    // The refusal that locked it also ended the session it came in.
    const ended = await api("/auth/me").then(
      () => false,
      (e) => statusOf(e) === 401,
    );
    if (!ended) return "locked";
    signInAgain(lang, "pinLocked");
    return "gone";
  }
  // A wrong password or PIN is a 401 too, with its own code.
  if (
    statusOf(err) === 401 &&
    code !== "wrong_password" &&
    code !== "password_locked"
  ) {
    signInAgain(lang, "ended");
    return "gone";
  }
  return null;
}
