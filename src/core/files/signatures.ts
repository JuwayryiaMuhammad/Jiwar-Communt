import type { FileContentType } from './purposes';

/** Bytes read at finalize: enough for every signature below. */
export const SIGNATURE_BYTES = 16;

const startsWith = (b: Buffer, bytes: number[], at = 0) =>
  b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const SIGNATURES: Record<FileContentType, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) =>
    startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  // RIFF <size> WEBP
  'image/webp': (b) =>
    startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  'application/pdf': (b) => startsWith(b, ascii('%PDF-')),
};

/**
 * Whether the first bytes of an object are the type it was declared as
 * (ADR 0029). The declared type is signed into the upload, so this catches
 * a renamed or disguised file, not a different header.
 */
export function matchesSignature(
  type: FileContentType,
  firstBytes: Buffer,
): boolean {
  return SIGNATURES[type](firstBytes);
}
