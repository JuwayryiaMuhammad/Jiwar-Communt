import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type ErrorParams,
} from '../common/errors';

export type SignatureKind =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'pdf'
  | 'mp4'
  | 'webm'
  | 'mp3'
  | 'm4a'
  | 'weba'
  | 'ogg'
  | 'wav'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'doc'
  | 'xls'
  | 'ppt';

/**
 * Container formats whose members share one set of magic bytes, so the bytes
 * can prove the container but never which member it holds. See `validateUpload`
 * for what that costs.
 */
type SignatureFamily = 'ooxml' | 'ole2' | 'isobmff' | 'ebml';

interface SignatureSpec {
  kind: SignatureKind;
  mime: string;
  ext: string;
  match: (buf: Buffer) => boolean;
  /** Set only for kinds that share their signature with a sibling kind. */
  family?: SignatureFamily;
  /**
   * Other MIME strings clients really send for this same kind. Recorders are
   * the reason this exists: the same m4a arrives as audio/mp4 from one and
   * audio/x-m4a from another, and neither is wrong.
   */
  aliases?: string[];
}

/** `PK\x03\x04` — the local file header every ZIP archive opens with. */
const isZip = (b: Buffer) =>
  b.length >= 4 &&
  b[0] === 0x50 &&
  b[1] === 0x4b &&
  b[2] === 0x03 &&
  b[3] === 0x04;

/** `D0 CF 11 E0 A1 B1 1A E1` — OLE2 compound file, the pre-2007 Office container. */
const isOle2 = (b: Buffer) =>
  b.length >= 8 &&
  b[0] === 0xd0 &&
  b[1] === 0xcf &&
  b[2] === 0x11 &&
  b[3] === 0xe0 &&
  b[4] === 0xa1 &&
  b[5] === 0xb1 &&
  b[6] === 0x1a &&
  b[7] === 0xe1;

/**
 * True for the pre-2007 Office container (.doc/.xls/.ppt).
 *
 * Exposed so an endpoint that accepts only the modern format can say "this is
 * the old format, re-save it" instead of the generic signature-mismatch
 * message, which reads as file corruption to the person uploading.
 */
export const looksLikeLegacyOffice = (buffer: Buffer): boolean =>
  isOle2(buffer.subarray(0, 12));

/**
 * Magic-byte detectors.
 *
 * Office formats come in two families that each share one signature: the
 * modern ones (docx/xlsx/pptx) are ZIP archives, the legacy ones
 * (doc/xls/ppt) are OLE2 compound files. Within a family the bytes cannot
 * tell the members apart, so they carry a `family` and `validateUpload`
 * settles the kind from the declared MIME once the container itself checks
 * out. That is strictly weaker than the other entries here — a spreadsheet
 * can be passed off as a document — and deliberately so: the alternative is
 * parsing the archive directory, and mislabelling one Office type as another
 * buys an attacker nothing this app acts on.
 *
 * Audio adds two more shared containers on the same terms: ISO-BMFF holds
 * both video/mp4 and audio/mp4 (m4a), and EBML holds both video/webm and
 * audio/webm (weba). The bytes prove the container; the declared MIME names
 * the member. The worst a lie buys here is a video file stored as a voice
 * note, which plays as one.
 */
export const SIGNATURES: SignatureSpec[] = [
  {
    kind: 'png',
    mime: 'image/png',
    ext: 'png',
    match: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    kind: 'jpeg',
    mime: 'image/jpeg',
    ext: 'jpg',
    match: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    kind: 'webp',
    mime: 'image/webp',
    ext: 'webp',
    match: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    kind: 'gif',
    mime: 'image/gif',
    ext: 'gif',
    // GIF87a / GIF89a
    match: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
  {
    kind: 'pdf',
    mime: 'application/pdf',
    ext: 'pdf',
    // %PDF
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x25 &&
      b[1] === 0x50 &&
      b[2] === 0x44 &&
      b[3] === 0x46,
  },
  {
    kind: 'mp4',
    mime: 'video/mp4',
    ext: 'mp4',
    // bytes 4-7 == 'ftyp'
    match: (b) =>
      b.length >= 8 &&
      b[4] === 0x66 &&
      b[5] === 0x74 &&
      b[6] === 0x79 &&
      b[7] === 0x70,
    // Shared with m4a: an ISO-BMFF box says nothing about whether the tracks
    // inside it carry video.
    family: 'isobmff',
  },
  {
    kind: 'webm',
    mime: 'video/webm',
    ext: 'webm',
    // EBML header: 1A 45 DF A3
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x1a &&
      b[1] === 0x45 &&
      b[2] === 0xdf &&
      b[3] === 0xa3,
    // Shared with weba, for the same reason.
    family: 'ebml',
  },
  {
    kind: 'm4a',
    mime: 'audio/mp4',
    ext: 'm4a',
    // Same ISO-BMFF 'ftyp' box as video/mp4 — see the family note above.
    match: (b) =>
      b.length >= 8 &&
      b[4] === 0x66 &&
      b[5] === 0x74 &&
      b[6] === 0x79 &&
      b[7] === 0x70,
    family: 'isobmff',
    aliases: ['audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/mp4a-latm'],
  },
  {
    kind: 'weba',
    mime: 'audio/webm',
    ext: 'weba',
    // Same EBML header as video/webm. This is what a browser's MediaRecorder
    // produces for a voice note on Chrome and Android.
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x1a &&
      b[1] === 0x45 &&
      b[2] === 0xdf &&
      b[3] === 0xa3,
    family: 'ebml',
  },
  {
    kind: 'mp3',
    mime: 'audio/mpeg',
    ext: 'mp3',
    // Either an ID3 tag ('ID3') or a bare MPEG frame sync (FF Ex/Fx).
    match: (b) =>
      (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
      (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
    aliases: ['audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'],
  },
  {
    kind: 'ogg',
    mime: 'audio/ogg',
    ext: 'ogg',
    // 'OggS' — the page header every Ogg stream opens with, Opus included.
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x4f &&
      b[1] === 0x67 &&
      b[2] === 0x67 &&
      b[3] === 0x53,
    aliases: ['audio/opus', 'audio/x-ogg', 'application/ogg'],
  },
  {
    kind: 'wav',
    mime: 'audio/wav',
    ext: 'wav',
    // RIFF....WAVE — the same RIFF container webp uses, told apart by the
    // form type at byte 8.
    match: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x41 &&
      b[10] === 0x56 &&
      b[11] === 0x45,
    aliases: ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  },
  {
    kind: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
    match: isZip,
    family: 'ooxml',
  },
  {
    kind: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
    match: isZip,
    family: 'ooxml',
  },
  {
    kind: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: 'pptx',
    match: isZip,
    family: 'ooxml',
  },
  {
    kind: 'doc',
    mime: 'application/msword',
    ext: 'doc',
    match: isOle2,
    family: 'ole2',
  },
  {
    kind: 'xls',
    mime: 'application/vnd.ms-excel',
    ext: 'xls',
    match: isOle2,
    family: 'ole2',
  },
  {
    kind: 'ppt',
    mime: 'application/vnd.ms-powerpoint',
    ext: 'ppt',
    match: isOle2,
    family: 'ole2',
  },
];

/**
 * Two-layer validation shared by every upload endpoint:
 *  1. Declared MIME must match one of the allowed kinds.
 *  2. The first bytes of the buffer must match that type's magic bytes —
 *     guards against a renamed file or a spoofed Content-Type header.
 * Throws VALIDATION_FAILED on `field` on any mismatch; returns the detected
 * spec.
 *
 * The one place the two layers cannot fully agree is a shared container: a
 * .docx and a .xlsx are both ZIP archives, so byte inspection proves "this is
 * an OOXML file" and no more. Within one family the declared MIME therefore
 * decides which member it is — and, critically, only there: a declared docx
 * whose bytes are a PDF, an executable, or anything else non-ZIP is still
 * rejected, which is the attack this function exists to stop.
 */
export function validateUpload(
  buffer: Buffer,
  mimetype: string,
  allowedKinds: SignatureKind[],
  field = 'file',
): SignatureSpec {
  const allowed = SIGNATURES.filter((s) => allowedKinds.includes(s.kind));

  // A browser's MediaRecorder declares `audio/webm;codecs=opus`, and case is
  // not significant in a media type. Strip the parameters and compare lower
  // case, or a legitimate recording is rejected on punctuation.
  const declaredMime = mimetype.split(';')[0].trim().toLowerCase();

  const declared = allowed.find(
    (s) => s.mime === declaredMime || s.aliases?.includes(declaredMime),
  );
  if (!declared) {
    throw invalidFile(
      field,
      FieldErrorCode.FILE_TYPE_NOT_ALLOWED,
      `Unsupported MIME type: ${declaredMime}`,
      { allowed: [...new Set(allowed.map((s) => s.mime))] },
    );
  }

  const head = buffer.subarray(0, 12);
  const detected = allowed.find((s) => s.match(head));
  if (!detected) {
    throw invalidFile(
      field,
      FieldErrorCode.FILE_SIGNATURE_MISMATCH,
      'File signature does not match any supported format',
    );
  }
  if (detected.kind !== declared.kind) {
    // Same container, different member: the bytes are as specific as they can
    // be, and the declared type is the only thing left that names the member.
    if (declared.family && declared.family === detected.family) {
      return declared;
    }
    throw invalidFile(
      field,
      FieldErrorCode.FILE_SIGNATURE_MISMATCH,
      `File signature (${detected.kind}) does not match declared MIME type (${declared.kind})`,
    );
  }

  return detected;
}

/** VALIDATION_FAILED on the upload's field, like any other invalid input. */
export function invalidFile(
  field: string,
  code: FieldErrorCode,
  message: string,
  params?: ErrorParams,
) {
  return appError.badRequest(ErrorCode.VALIDATION_FAILED, message, {
    fields: [{ field, code, ...(params && { params }) }],
  });
}
