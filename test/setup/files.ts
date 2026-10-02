import { API, type HttpHarness } from './http-app';

/** Real signatures followed by filler: what finalize accepts per type. */
export const SAMPLE: Record<string, Buffer> = {
  'image/png': Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40, 1),
  ]),
  'image/jpeg': Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(40, 2),
  ]),
  'image/webp': Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(32, 3),
  ]),
  'application/pdf': Buffer.from('%PDF-1.7\n% not really a document\n'),
};

export interface Upload {
  id: string;
  upload: {
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  };
}

/** Uploads through the API (ADR 0029), the way an app does. */
export function fileHelpers(h: HttpHarness) {
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function declare(
    token: string,
    purpose: string,
    contentType: string,
    size: number,
  ): Promise<Upload> {
    const res = await h
      .http()
      .post(`${API}/files/uploads`)
      .set(auth(token))
      .send({ purpose, contentType, size });
    if (res.status !== 201)
      throw new Error(`declare: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as Upload;
  }

  /** The PUT straight to the store, with the headers the API returned. */
  const put = (u: Upload, body: Buffer, headers: Record<string, string> = {}) =>
    fetch(u.upload.url, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { ...u.upload.headers, ...headers },
    });

  const finalize = (token: string, id: string) =>
    h.http().post(`${API}/files/${id}/finalize`).set(auth(token)).send({});

  /** Declared, uploaded, not finalized. */
  async function uploaded(
    token: string,
    purpose = 'worker_photo',
    contentType = 'image/png',
    body: Buffer = SAMPLE[contentType],
  ): Promise<string> {
    const u = await declare(token, purpose, contentType, body.length);
    const res = await put(u, body);
    if (res.status !== 200) throw new Error(`PUT: ${res.status}`);
    return u.id;
  }

  /** A finalized file of the caller's. */
  async function ready(
    token: string,
    purpose = 'worker_photo',
    contentType = 'image/png',
  ): Promise<string> {
    const id = await uploaded(token, purpose, contentType);
    const res = await finalize(token, id);
    if (res.status !== 200)
      throw new Error(`finalize: ${res.status} ${JSON.stringify(res.body)}`);
    return id;
  }

  return { declare, put, finalize, uploaded, ready };
}
