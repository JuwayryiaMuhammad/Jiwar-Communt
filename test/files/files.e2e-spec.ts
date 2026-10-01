import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { RequestContextModule } from '../../src/core/common/cls/request-context.module';
import { validateEnv } from '../../src/core/config/env.schema';
import { FilesModule } from '../../src/core/files/files.module';
import {
  FilesService,
  type StoredFile,
} from '../../src/core/files/files.service';
import type { UploadFolder } from '../../src/core/files/upload-folder.enum';

/** No folder exists until a feature adds one (ADR 0029). */
const FOLDER = 'test-folder' as unknown as UploadFolder;
const TENANT = '0190a0a0-0000-7000-8000-0000000000f1';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('not really pixels'),
]);
const photo = {
  fieldname: 'photo',
  buffer: PNG,
  mimetype: 'image/png',
  originalname: 'me.png',
};

/** FilesService against the local MinIO's test bucket (test-env.ts). */
describe('FilesService (object storage)', () => {
  let moduleRef: TestingModule;
  let cls: ClsService<AppClsStore>;
  let files: FilesService;

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(async () => {
      cls.set('tenantId', TENANT);
      return await fn();
    });
  const store = () =>
    asTenant(() =>
      files.storeImage(FOLDER, photo, (stored) => Promise.resolve(stored)),
    );
  const url = (key: string) => asTenant(() => files.url(key));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnv,
        }),
        ClsModule.forRoot({ global: true }),
        RequestContextModule,
        FilesModule,
      ],
    }).compile();
    await moduleRef.init();
    cls = moduleRef.get<ClsService<AppClsStore>>(ClsService);
    files = moduleRef.get(FilesService);
  });

  afterAll(() => moduleRef.close());

  it('stores the bytes under the detected type, readable by a presigned URL', async () => {
    const stored = await store();
    const signed = await url(stored.key);

    expect(new URL(signed).searchParams.get('X-Amz-Expires')).toBe('300');
    const res = await fetch(signed);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('keeps the bucket private: no unsigned read', async () => {
    const stored = await store();
    const signed = new URL(await url(stored.key));
    const res = await fetch(`${signed.origin}${signed.pathname}`);
    expect(res.status).toBe(403);
  });

  // A rolled-back action leaves no file behind.
  it('deletes the object when the write throws', async () => {
    let stored: StoredFile | undefined;
    await expect(
      asTenant(() =>
        files.storeImage(FOLDER, photo, (s) => {
          stored = s;
          return Promise.reject(new Error('transaction rolled back'));
        }),
      ),
    ).rejects.toThrow('transaction rolled back');

    const res = await fetch(await url(stored!.key));
    expect(res.status).toBe(404);
  });

  it('deleteObject removes a stored object', async () => {
    const stored = await store();
    await files.deleteObject(stored.key);
    expect((await fetch(await url(stored.key))).status).toBe(404);
  });
});
