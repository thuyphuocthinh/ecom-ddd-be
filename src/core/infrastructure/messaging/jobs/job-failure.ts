/**
 * A short, safe description of why a job failed: the error's code and name only. The
 * message is left out on purpose, because SMTP and driver messages often quote the
 * recipient's address or the data that was being processed.
 */
export function describeFailure(error: unknown): string {
  const e = error as { code?: unknown; responseCode?: unknown; name?: unknown };
  const parts = [e?.code, e?.responseCode, e?.name]
    .filter(
      (part): part is string | number =>
        typeof part === 'string' || typeof part === 'number',
    )
    .map((part) =>
      String(part)
        .replace(/[^\w.-]/g, '')
        .slice(0, 40),
    );
  return parts.filter(Boolean).join(' ') || 'unknown error';
}
