import { AppException } from '../common/errors';
import { SignatureKind, validateUpload } from './upload-validator';

const DOCUMENT_KINDS: SignatureKind[] = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
];

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  png: 'image/png',
};

const bytes = {
  // PK\x03\x04 + filler: every OOXML file is a ZIP archive.
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
  // OLE2 compound file: the pre-2007 Office container.
  ole2: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  pdf: Buffer.from('%PDF-1.7\n'),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

describe('validateUpload — Office documents', () => {
  it('accepts a Word document by its ZIP container', () => {
    expect(validateUpload(bytes.zip, MIME.docx, DOCUMENT_KINDS).ext).toBe(
      'docx',
    );
  });

  // docx and xlsx are the same archive format, so the declared MIME is the
  // only thing that can name which one it is. Both must resolve to their own
  // extension rather than to whichever spec happens to be listed first.
  it('settles which OOXML member it is from the declared type', () => {
    expect(validateUpload(bytes.zip, MIME.xlsx, DOCUMENT_KINDS).ext).toBe(
      'xlsx',
    );
  });

  it('accepts a legacy .doc by its OLE2 container', () => {
    expect(validateUpload(bytes.ole2, MIME.doc, DOCUMENT_KINDS).ext).toBe(
      'doc',
    );
  });

  it('still accepts a PDF, which has a signature of its own', () => {
    expect(validateUpload(bytes.pdf, MIME.pdf, DOCUMENT_KINDS).ext).toBe('pdf');
  });

  // The point of the whole function: the family shortcut must not become a way
  // to smuggle arbitrary bytes past it under an Office MIME type.
  it('rejects non-ZIP bytes declared as a Word document', () => {
    expect(() => validateUpload(bytes.pdf, MIME.docx, DOCUMENT_KINDS)).toThrow(
      AppException,
    );
  });

  it('rejects a document declared as one, whatever its bytes, when not allowed', () => {
    expect(() => validateUpload(bytes.zip, MIME.docx, ['pdf'])).toThrow(
      /Unsupported MIME type/,
    );
  });

  // Different containers, so the family shortcut must not bridge them.
  it('rejects an OLE2 file declared as a modern .docx', () => {
    expect(() => validateUpload(bytes.ole2, MIME.docx, DOCUMENT_KINDS)).toThrow(
      AppException,
    );
  });

  // The error contract (ADR 0013): a coded field error, never display text.
  it('reports a coded field error on the upload field', () => {
    const body = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as AppException).getResponse();
      }
      throw new Error('expected a throw');
    };
    expect(
      body(() =>
        validateUpload(bytes.zip, 'image/gif', ['png', 'pdf'], 'photo'),
      ),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [
        {
          field: 'photo',
          code: 'FILE_TYPE_NOT_ALLOWED',
          params: { allowed: ['image/png', 'application/pdf'] },
        },
      ],
    });
    expect(
      body(() => validateUpload(bytes.pdf, MIME.docx, DOCUMENT_KINDS)),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ field: 'file', code: 'FILE_SIGNATURE_MISMATCH' }],
    });
  });

  it('leaves the image rules alone', () => {
    expect(validateUpload(bytes.png, MIME.png, ['png']).ext).toBe('png');
    expect(() => validateUpload(bytes.zip, MIME.png, ['png'])).toThrow(
      AppException,
    );
  });
});

const AUDIO_KINDS: SignatureKind[] = ['mp3', 'm4a', 'weba', 'ogg', 'wav'];
/** What a chat client may upload: the audio kinds plus their video siblings. */
const CHAT_KINDS: SignatureKind[] = [...AUDIO_KINDS, 'mp4', 'webm', 'png'];

const audioBytes = {
  // EBML header — what MediaRecorder emits for audio/webm;codecs=opus.
  ebml: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]),
  // ....ftyp + brand: the ISO-BMFF box m4a and mp4 share.
  ftyp: Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
  ]),
  id3: Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00]),
  // Bare MPEG frame sync, for an mp3 recorded without a tag.
  frameSync: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]),
  ogg: Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]),
  wav: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('WAVE'),
  ]),
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('WEBP'),
  ]),
};

describe('validateUpload — recorded audio', () => {
  it('accepts a browser recording declared with its codec parameter', () => {
    // `audio/webm;codecs=opus` is what MediaRecorder actually sends; an exact
    // string compare would reject every voice note Chrome records.
    const spec = validateUpload(
      audioBytes.ebml,
      'audio/webm;codecs=opus',
      AUDIO_KINDS,
    );
    expect(spec.ext).toBe('weba');
    expect(spec.mime).toBe('audio/webm');
  });

  it('accepts an m4a under whichever of its names the recorder used', () => {
    for (const mime of ['audio/mp4', 'audio/x-m4a', 'AUDIO/X-M4A']) {
      expect(validateUpload(audioBytes.ftyp, mime, AUDIO_KINDS).ext).toBe(
        'm4a',
      );
    }
  });

  it('accepts an mp3 with or without an ID3 tag', () => {
    expect(validateUpload(audioBytes.id3, 'audio/mpeg', AUDIO_KINDS).ext).toBe(
      'mp3',
    );
    expect(
      validateUpload(audioBytes.frameSync, 'audio/mp3', AUDIO_KINDS).ext,
    ).toBe('mp3');
  });

  it('accepts ogg/opus and wav', () => {
    expect(validateUpload(audioBytes.ogg, 'audio/opus', AUDIO_KINDS).ext).toBe(
      'ogg',
    );
    expect(validateUpload(audioBytes.wav, 'audio/wav', AUDIO_KINDS).ext).toBe(
      'wav',
    );
  });

  // The shared containers: byte inspection proves ISO-BMFF or EBML and no
  // more, so each member has to come back as itself rather than as whichever
  // sibling is listed first.
  it('tells the audio and video members of a shared container apart', () => {
    expect(validateUpload(audioBytes.ftyp, 'audio/mp4', CHAT_KINDS).ext).toBe(
      'm4a',
    );
    expect(validateUpload(audioBytes.ftyp, 'video/mp4', CHAT_KINDS).ext).toBe(
      'mp4',
    );
    expect(validateUpload(audioBytes.ebml, 'audio/webm', CHAT_KINDS).ext).toBe(
      'weba',
    );
    expect(validateUpload(audioBytes.ebml, 'video/webm', CHAT_KINDS).ext).toBe(
      'webm',
    );
  });

  it('rejects non-audio bytes declared as a recording', () => {
    expect(() => validateUpload(bytes.pdf, 'audio/mpeg', AUDIO_KINDS)).toThrow(
      AppException,
    );
    expect(() => validateUpload(bytes.zip, 'audio/webm', AUDIO_KINDS)).toThrow(
      AppException,
    );
  });

  // Both open 'RIFF'; only the form type at byte 8 separates them.
  it('does not confuse a webp with a wav', () => {
    expect(() =>
      validateUpload(audioBytes.webp, 'audio/wav', AUDIO_KINDS),
    ).toThrow(AppException);
    expect(() =>
      validateUpload(audioBytes.wav, 'image/webp', ['webp', ...AUDIO_KINDS]),
    ).toThrow(AppException);
  });

  it('still refuses audio where the caller did not allow it', () => {
    expect(() =>
      validateUpload(audioBytes.ebml, 'audio/webm', ['png', 'jpeg']),
    ).toThrow(/Unsupported MIME type/);
  });
});
