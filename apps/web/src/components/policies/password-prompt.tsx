"use client";

import type { ComponentProps } from "react";
import { SignaturePrompt } from "@/components/signing/signature-prompt";
import type { PoliciesText } from "./types";

/** A signature on a document: the shared prompt, in the documents' words. */
export function PasswordPrompt({
  t,
  ...props
}: Omit<ComponentProps<typeof SignaturePrompt>, "words"> & { t: PoliciesText }) {
  return (
    <SignaturePrompt
      {...props}
      words={{
        ...t.signature,
        wrongPassword: t.errors.wrong_password,
        passwordLocked: t.errors.password_locked,
        pinLocked: t.errors.signing_pin_locked,
        cancel: t.actions.cancel,
      }}
    />
  );
}
