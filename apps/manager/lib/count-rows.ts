/**
 * How many rows a list holds, by following its pages (ADR 0072) up to `max`
 * rows: the exact number when the list ends before, `more` when it goes on.
 * For a count a person reads; a badge that only needs "some" reads one page.
 */
export async function countRows(
  fetchPage: (cursor?: string) => Promise<{ data: unknown[]; nextCursor?: string | null }>,
  max = 1000,
): Promise<{ count: number; more: boolean }> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    count += page.data.length;
    if (!page.nextCursor) return { count, more: false };
    if (count >= max) return { count, more: true };
    cursor = page.nextCursor;
  }
}
