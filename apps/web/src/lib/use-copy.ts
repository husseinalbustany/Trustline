"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Copies text to the clipboard and says so for a moment. Returns whether it
 * has just been copied, and the function that copies.
 *
 * What is copied is never kept here, and "Copied" does not wait on a page
 * that was left: visited pages stay mounted.
 */
export function useCopy(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(
    () => () => {
      clearTimeout(timer.current);
      setCopied(false);
    },
    [],
  );

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard blocked: what was to be copied is on the page, selectable.
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 4000);
  }

  return [copied, copy];
}
