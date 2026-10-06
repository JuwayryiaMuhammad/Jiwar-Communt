import { unzipSync } from 'fflate';
import { DATA_EXPORT_BUILD_SWEEP } from '../../src/core/exports/data-exports.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { API, type HttpHarness } from './http-app';
import { waitForOtp } from './mailpit';

/** A fresh step-up on the token's session (ADR 0036), through the API. */
export async function stepUp(
  h: HttpHarness,
  token: string,
  email: string,
): Promise<void> {
  const since = new Date();
  await h
    .http()
    .post(`${API}/me/step-up`)
    .set('Authorization', `Bearer ${token}`)
    .send({})
    .expect(202);
  const code = await waitForOtp(email, since);
  await h
    .http()
    .post(`${API}/me/step-up/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({ code })
    .expect(200);
}

/** Runs the build sweep until nothing is left to build. */
export async function buildExports(h: HttpHarness, now = new Date()) {
  const sweep = h.moduleRef.get(SweepRunner);
  while ((await sweep.run(DATA_EXPORT_BUILD_SWEEP, now)) > 0);
}

/** The archive behind a presigned URL, entry by entry, as text or bytes. */
export async function readArchive(url: string): Promise<{
  names: string[];
  text: (name: string) => string;
  bytes: (name: string) => Buffer;
  all: string;
}> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`archive download failed: ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const names = Object.keys(files).sort();
  const text = (name: string) => Buffer.from(files[name]).toString('utf8');
  return {
    names,
    text,
    bytes: (name) => Buffer.from(files[name]),
    all: names
      .filter((n) => n.endsWith('.json'))
      .map(text)
      .join('\n'),
  };
}
