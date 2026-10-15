/**
 * The backend's response headers the browser gets: its type, the request
 * id for support, and a download's name (a CSV export, ADR 0048).
 */
export const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'content-disposition',
];

/**
 * A successful body as the browser should get it. JSON is relayed as text;
 * anything else (a CSV export) as the bytes the backend sent: decoding to
 * text would drop a CSV's byte-order mark, and spreadsheet apps then misread
 * its Arabic.
 */
export async function successBody(
  upstream: Response,
): Promise<string | ArrayBuffer> {
  const type = upstream.headers.get('content-type') ?? '';
  return /^application\/json\b/i.test(type)
    ? upstream.text()
    : upstream.arrayBuffer();
}
