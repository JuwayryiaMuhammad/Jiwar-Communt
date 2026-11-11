/**
 * A value as JSON, for "this never appears" checks, with what the server
 * mints at random or from the clock taken out first: a signed URL's query,
 * UUIDs, ISO instants and hex digests. A short run of digits (the last four
 * of an ID, a plate's number) is found by chance inside them: `456` is in
 * about one row in twelve of two audit rows, and a photo's signed URL dated
 * 2026-11-11 carries `20261111` in its `X-Amz-Date` and its credential. Free
 * text, codes and names are left as they are.
 */
export function leakText(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\?X-Amz-[^"\s]*/g, '?<signed>')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<id>',
    )
    .replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g,
      '<at>',
    )
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hex>');
}
