import type { ConfigService } from '@nestjs/config';
import { IdentifierHasher } from '../../core/auth/identifier';
import type { Env } from '../../core/config/env.schema';
import {
  deriveParcelToken,
  PARCEL_QR_PREFIX,
  ParcelTokens,
} from './parcel-tokens';

const KEY = 'parcel-token-key-for-the-test-vector!';
const PEPPER = 'b'.repeat(32);
const TENANT = '01a102b6-6253-74a0-92b1-96e7c9d52601';
const CREDENTIAL = '01a102b6-6253-74a0-92b1-9b0320a0f082';

const config = (values: Record<string, string>) =>
  ({
    get: (name: string) => values[name],
  }) as unknown as ConfigService<Env, true>;

const tokens = new ParcelTokens(
  config({ PARCEL_TOKEN_KEY: KEY }),
  new IdentifierHasher(config({ IDENTIFIER_PEPPER: PEPPER })),
);

/**
 * The vectors below were computed independently of this code (Python's hmac
 * and hashlib), so a change to the derivation, the code or a label fails here.
 */
describe('parcel tokens (ADR 0035)', () => {
  it('derives the pinned token, code, QR and hashes', () => {
    expect(deriveParcelToken(KEY, TENANT, CREDENTIAL, 0)).toBe(
      'mpJXvvqzs0yE2G5IjnA0iTpU5ILVI7qvi8165zIgalA',
    );
    expect(tokens.secretOf(TENANT, CREDENTIAL, 0)).toEqual({
      token: 'mpJXvvqzs0yE2G5IjnA0iTpU5ILVI7qvi8165zIgalA',
      code: '522251',
      qrPayload: 'JWP1.mpJXvvqzs0yE2G5IjnA0iTpU5ILVI7qvi8165zIgalA',
      codeHash:
        '3bd778f90698ae538fc77a18c287ba380d4fa5e6c55692db004ff7ef74a67f0c',
      qrTokenHash:
        '38ccea7881b9060dba7995eda0693ab8f05b079d40aceb7e48a42e96bb92c994',
    });
    expect(tokens.secretOf(TENANT, CREDENTIAL, 1)).toMatchObject({
      token: '4h6IqIHI_4dApnp9NIH8C5tZeuh8cHWmmnk95PRrt6o',
      code: '127035',
      codeHash:
        'b87fb6c3f6b28be431094c2f6b8e3d34bbb84b8982ff7f9aad71d22b2adccfda',
      qrTokenHash:
        '476925b90dc7ce0b01400d7a48828699d8f96680ed617f1c05fa936526d15af5',
    });
  });

  it('the same inputs give the same secret; any input changed gives another', () => {
    const a = tokens.secretOf(TENANT, CREDENTIAL, 0);
    expect(tokens.secretOf(TENANT, CREDENTIAL, 0)).toEqual(a);
    const other = '01a102b6-6253-74a0-92b1-9b0320a0f083';
    for (const s of [
      tokens.secretOf(TENANT, other, 0),
      tokens.secretOf(other, CREDENTIAL, 0),
      tokens.secretOf(TENANT, CREDENTIAL, 1),
    ]) {
      expect(s.token).not.toBe(a.token);
      expect(s.qrTokenHash).not.toBe(a.qrTokenHash);
    }
  });

  it('a code is bound to its compound and to parcels: not a visitor’s or a worker’s hash', () => {
    const hasher = new IdentifierHasher(config({ IDENTIFIER_PEPPER: PEPPER }));
    const { code, token } = tokens.secretOf(TENANT, CREDENTIAL, 0);
    expect(tokens.codeHashOf(TENANT, code)).not.toBe(
      hasher.hashVisitorCode(TENANT, code),
    );
    expect(tokens.codeHashOf(TENANT, code)).not.toBe(
      hasher.hashWorkerCode(TENANT, code),
    );
    expect(tokens.codeHashOf(TENANT, code)).not.toBe(
      tokens.codeHashOf(CREDENTIAL, code),
    );
    expect(tokens.qrHashOf(TENANT, token)).not.toBe(
      hasher.hashQrToken(TENANT, token),
    );
  });

  it('parses only a JWP1 QR with a 43-character token', () => {
    const { token, qrPayload } = tokens.secretOf(TENANT, CREDENTIAL, 0);
    expect(token).toHaveLength(43);
    expect(tokens.parseQr(qrPayload)).toBe(token);
    expect(tokens.parseQr(`  ${qrPayload}\n`)).toBe(token);
    for (const bad of [
      `JWR1.${token}`,
      `JWR2.${token}`,
      PARCEL_QR_PREFIX,
      `${PARCEL_QR_PREFIX}${token}x`,
      `${PARCEL_QR_PREFIX}${token.slice(1)}`,
      `${PARCEL_QR_PREFIX}${'!'.repeat(43)}`,
      token,
      '',
    ])
      expect(tokens.parseQr(bad)).toBeNull();
  });

  it('a taken code gives the next attempt’s token, never another code for the same token', async () => {
    const first = tokens.secretOf(TENANT, CREDENTIAL, 0);
    const taken = new Set([first.codeHash]);
    const got = await tokens.allocate(TENANT, CREDENTIAL, (hash) =>
      Promise.resolve(taken.has(hash)),
    );
    expect(got.attempt).toBe(1);
    expect(got.code).toBe('127035');
    expect(
      await tokens.allocate(TENANT, CREDENTIAL, () => Promise.resolve(false)),
    ).toMatchObject({ attempt: 0, code: first.code });
  });

  it('gives up after ten collisions in a row', async () => {
    await expect(
      tokens.allocate(TENANT, CREDENTIAL, () => Promise.resolve(true)),
    ).rejects.toThrow(/No free parcel code/);
  });

  it('codes are six digits', () => {
    for (let attempt = 0; attempt < 50; attempt++)
      expect(tokens.secretOf(TENANT, CREDENTIAL, attempt).code).toMatch(
        /^\d{6}$/,
      );
  });
});
