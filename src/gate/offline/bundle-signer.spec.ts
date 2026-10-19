import { generateKeyPairSync } from 'node:crypto';
import { signedBy } from './device-envelope';
import { bundleMessage, BundleSigner } from './bundle-signer';

/**
 * Computed independently (Python's `cryptography`), with RFC 8032's second
 * test key: ADR 0057 and the apps' notes repeat them for the device's tests.
 */
const VECTOR = {
  seed: 'TM0Imyj_ltqdtsNG7BFOD1uKMZ81q6Yk2oz27U-4pvs',
  publicKey: 'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw',
  body: 'eyJ2IjoxLCJidW5kbGVJZCI6IjAxYTEwMmI2LTYyNTMtNzRhMC05MmIxLWEwYzRlNWY2MDcxOCJ9',
  signature:
    'adaLnWIbdvnfbZ_zoKpG8bJhIqsOcnuI5WaaZ6lJBXfow-oayieYpiZobg2ABJ_UG5SwGclkTnfL0ddlsk6bBg',
};

const signerWith = (env: Record<string, unknown>) =>
  new BundleSigner({ get: (k: string) => env[k] } as never);

describe('the bundle’s signature (ADR 0057)', () => {
  it('signs the vector, and publishes the key’s public half', () => {
    const signer = signerWith({
      GATE_BUNDLE_SIGNING_KEY: VECTOR.seed,
      GATE_BUNDLE_SIGNING_KEY_VERSION: 3,
    });
    expect(signer.keyVersion).toBe(3);
    expect(signer.sign(VECTOR.body)).toBe(VECTOR.signature);
    expect(signer.publicKeys()).toEqual([
      { version: 3, publicKey: VECTOR.publicKey, current: true },
    ]);
    expect(
      signedBy(VECTOR.publicKey, bundleMessage(VECTOR.body), VECTOR.signature),
    ).toBe(true);
  });

  it('a seed in standard base64 is the same key', () => {
    const b64 = Buffer.from(VECTOR.seed, 'base64url').toString('base64');
    expect(
      signerWith({
        GATE_BUNDLE_SIGNING_KEY: b64,
        GATE_BUNDLE_SIGNING_KEY_VERSION: 1,
      }).sign(VECTOR.body),
    ).toBe(VECTOR.signature);
  });

  it('a rotation: the retired public key is still published, newest first', () => {
    const old = generateKeyPairSync('ed25519').publicKey.export({
      format: 'jwk',
    }).x!;
    const signer = signerWith({
      GATE_BUNDLE_SIGNING_KEY: VECTOR.seed,
      GATE_BUNDLE_SIGNING_KEY_VERSION: 4,
      GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS: `3:${old}`,
    });
    expect(signer.publicKeys()).toEqual([
      { version: 4, publicKey: VECTOR.publicKey, current: true },
      { version: 3, publicKey: old, current: false },
    ]);
  });

  it('a body changed by one character is not what was signed', () => {
    expect(
      signedBy(
        VECTOR.publicKey,
        bundleMessage(VECTOR.body.slice(0, -1) + 'A'),
        VECTOR.signature,
      ),
    ).toBe(false);
  });
});
