/** The Postgres error code of a failed query, e.g. 23505 for a unique clash. */
export function pgErrorCode(e: unknown): string | undefined {
  for (const x of [e, (e as { cause?: unknown })?.cause]) {
    const code = (x as { code?: unknown })?.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
