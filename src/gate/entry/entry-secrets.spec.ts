import {
  deriveEntrySecret,
  ENTRY_STEP_SECONDS,
  entryMac,
  entryQr,
  entryStep,
  macsEqual,
  parseEntryQr,
} from './entry-secrets';

/**
 * Fixed vectors, computed independently (Python's hmac): ADR 0031 repeats
 * them for the app's implementation.
 */
const VECTOR = {
  key: 'entry-credential-key-for-the-test-vector!',
  tenantId: '01a102b6-6253-74a0-92b1-96e7c9d52601',
  credentialId: '01a102b6-6253-74a0-92b1-9b0320a0f082',
  step: 57_000_000,
};

describe('entry secrets (ADR 0031)', () => {
  it('derive deterministically from the key, the compound and the credential', () => {
    const { key, tenantId, credentialId } = VECTOR;
    const a = deriveEntrySecret(key, tenantId, credentialId);
    expect(a).toHaveLength(32);
    expect(deriveEntrySecret(key, tenantId, credentialId)).toEqual(a);
    expect(deriveEntrySecret(key + 'x', tenantId, credentialId)).not.toEqual(a);
    expect(
      deriveEntrySecret(
        key,
        '01a102b6-6253-74a0-92b1-96e7c9d52602',
        credentialId,
      ),
    ).not.toEqual(a);
    expect(
      deriveEntrySecret(key, tenantId, '01a102b6-6253-74a0-92b1-9b0320a0f083'),
    ).not.toEqual(a);
  });

  it('has fixed vectors an app can check against', () => {
    const { key, tenantId, credentialId, step } = VECTOR;
    const secret = deriveEntrySecret(key, tenantId, credentialId);
    expect(secret.toString('base64url')).toBe(
      'SnesZhBDblL80n60Xav3cGPbYlitMYWykaQbezrT0_8',
    );
    expect(entryMac(secret, credentialId, step)).toBe('Naci2fBCUmF3tcpODWNL7w');
  });

  it('macs are 22 base64url characters and depend on the step and the id', () => {
    const { key, tenantId, credentialId, step } = VECTOR;
    const secret = deriveEntrySecret(key, tenantId, credentialId);
    const mac = entryMac(secret, credentialId, step);
    expect(mac).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(entryMac(secret, credentialId, step + 1)).not.toBe(mac);
    expect(entryMac(secret, 'another-id', step)).not.toBe(mac);
  });

  it('steps are 30 seconds long', () => {
    expect(ENTRY_STEP_SECONDS).toBe(30);
    expect(entryStep(0)).toBe(0);
    expect(entryStep(29_999)).toBe(0);
    expect(entryStep(30_000)).toBe(1);
    expect(entryStep(1_700_000_000_000)).toBe(56_666_666);
  });

  it('a payload parses only when it is exactly JWR2.<uuid>.<digits>.<22 chars>', () => {
    const { credentialId } = VECTOR;
    const mac = 'AAAAAAAAAAAAAAAAAAAAAA';
    expect(parseEntryQr(entryQr(credentialId, 5, mac))).toEqual({
      credentialId,
      step: 5,
      mac,
    });
    for (const bad of [
      '',
      'JWR1.' + 'a'.repeat(43),
      `JWR2.${credentialId}.5`,
      `JWR2.${credentialId}.five.${mac}`,
      `JWR2.${credentialId}.-5.${mac}`,
      `JWR2.${credentialId}.5.${mac}A`,
      `JWR2.${credentialId}.5.${mac.slice(1)}`,
      `JWR2.not-a-uuid.5.${mac}`,
      `JWR2.${credentialId}.${'9'.repeat(13)}.${mac}`,
      `jwr2.${credentialId}.5.${mac}`,
      `JWR2.${credentialId.toUpperCase()}.5.${mac}`,
    ])
      expect(parseEntryQr(bad)).toBeNull();
  });

  it('compares macs in constant time and by length', () => {
    expect(macsEqual('abc', 'abc')).toBe(true);
    expect(macsEqual('abc', 'abd')).toBe(false);
    expect(macsEqual('abc', 'abcd')).toBe(false);
  });
});
