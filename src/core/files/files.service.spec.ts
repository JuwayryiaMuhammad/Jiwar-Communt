import type { RequestContext } from '../common/cls/request-context';
import type { AppException } from '../common/errors';
import { FilesService, type UploadCandidate } from './files.service';
import type { ObjectStorage } from './object-storage';
import type { UploadFolder } from './upload-folder.enum';

/** No folder exists until a feature adds one (ADR 0029). */
const FOLDER = 'test-folder' as unknown as UploadFolder;
const TENANT = '0190a0a0-0000-7000-8000-000000000001';

const png = (bytes = 64): UploadCandidate => ({
  fieldname: 'photo',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, bytes - 8)),
  ]),
  mimetype: 'image/png',
  originalname: 'me.png',
});
const pdf: UploadCandidate = {
  buffer: Buffer.from('%PDF-1.7\n'),
  mimetype: 'application/pdf',
  originalname: 'lease.pdf',
};

function errorBody(error: unknown) {
  return (error as AppException).getResponse();
}

describe('FilesService', () => {
  let storage: {
    put: jest.Mock;
    delete: jest.Mock;
    signedUrl: jest.Mock;
  };
  let files: FilesService;

  beforeEach(() => {
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      signedUrl: jest.fn((key: string) => Promise.resolve(`signed:${key}`)),
    };
    files = new FilesService(
      storage as unknown as ObjectStorage,
      { tenantId: TENANT } as RequestContext,
    );
  });

  it("stores under the tenant's prefix, then writes with the stored file", async () => {
    const write = jest.fn((stored: { key: string }) =>
      Promise.resolve(stored.key),
    );
    const key = await files.storeImage(FOLDER, png(), write);

    expect(key).toMatch(
      new RegExp(`^${TENANT}/test-folder/[0-9a-f-]{36}\\.png$`),
    );
    expect(storage.put).toHaveBeenCalledWith(
      key,
      expect.any(Buffer),
      'image/png',
    );
    expect(write).toHaveBeenCalledWith({
      key,
      name: 'me.png',
      size: 64,
      mimeType: 'image/png',
    });
    expect(storage.put.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0],
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  // A rolled-back action must not leave the file behind.
  it('deletes the object when the write throws, and rethrows', async () => {
    const failure = new Error('transaction rolled back');
    await expect(
      files.storeDocument(FOLDER, pdf, () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    const [key] = storage.put.mock.calls[0] as [string];
    expect(storage.delete).toHaveBeenCalledWith(key);
  });

  it('validates before touching storage or the database', async () => {
    const write = jest.fn();
    const cases: [Promise<unknown>, object][] = [
      [
        files.storeImage(FOLDER, undefined, write),
        { field: 'file', code: 'FIELD_REQUIRED' },
      ],
      [
        files.storeImage(FOLDER, png(5 * 1024 * 1024 + 1), write),
        {
          field: 'photo',
          code: 'FILE_TOO_LARGE',
          params: { maxBytes: 5 * 1024 * 1024 },
        },
      ],
      // A PDF where a photo goes is never what the caller meant.
      [
        files.storeImage(FOLDER, pdf, write),
        { field: 'file', code: 'FILE_TYPE_NOT_ALLOWED' },
      ],
      [
        files.storeDocument(
          FOLDER,
          { ...pdf, mimetype: 'application/msword' },
          write,
        ),
        { field: 'file', code: 'FILE_SIGNATURE_MISMATCH' },
      ],
    ];
    for (const [attempt, fieldError] of cases) {
      const error: unknown = await attempt.catch((e: unknown) => e);
      expect(errorBody(error)).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [fieldError],
      });
    }
    expect(storage.put).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('allows documents up to 20 MB', async () => {
    const big = {
      ...pdf,
      buffer: Buffer.concat([pdf.buffer, Buffer.alloc(12 * 1024 * 1024)]),
    };
    await files.storeDocument(FOLDER, big, () => Promise.resolve());
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it("signs only the tenant's own keys", async () => {
    await expect(files.url(`${TENANT}/test-folder/a.png`)).resolves.toBe(
      `signed:${TENANT}/test-folder/a.png`,
    );
    expect(() => files.url('another-tenant/test-folder/a.png')).toThrow(
      /another tenant/,
    );
    // A prefix match on the id alone would let `${TENANT}x/…` through.
    expect(() => files.url(`${TENANT}x/test-folder/a.png`)).toThrow(
      /another tenant/,
    );
  });

  it('ignores a missing key on delete', async () => {
    await files.deleteObject(null);
    await files.deleteObject(undefined);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
