import {
  checkpointPayload,
  checkpointTokenHash,
  checkpointTokenMatches,
  issueCheckpointSecret,
  parseCheckpointPayload,
} from './checkpoint-tokens';

/**
 * A fixed vector, computed independently (Python's hashlib): ADR 0052
 * repeats it for the app's tests.
 */
const VECTOR = {
  tenantId: '01a102b6-6253-74a0-92b1-96e7c9d52601',
  checkpointId: '01a102b6-6253-74a0-92b1-9b0320a0f082',
  token: 'q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
  hash: 'd418826836142d030db0cb261c6e8f48f9664b936803d734c676fe8be7e7775b',
};

describe('checkpoint tokens (ADR 0052)', () => {
  it('hash the labelled token with SHA-256, no key involved', () => {
    const { tenantId, checkpointId, token, hash } = VECTOR;
    expect(checkpointTokenHash(tenantId, checkpointId, token)).toBe(hash);
  });

  it('a hash belongs to one compound and one checkpoint', () => {
    const { tenantId, checkpointId, token, hash } = VECTOR;
    expect(
      checkpointTokenHash(
        '01a102b6-6253-74a0-92b1-96e7c9d52602',
        checkpointId,
        token,
      ),
    ).not.toBe(hash);
    expect(
      checkpointTokenHash(
        tenantId,
        '01a102b6-6253-74a0-92b1-9b0320a0f083',
        token,
      ),
    ).not.toBe(hash);
  });

  it('issues 256 random bits, a payload the app parses back, and its hash', () => {
    const { tenantId, checkpointId } = VECTOR;
    const a = issueCheckpointSecret(tenantId, checkpointId);
    const b = issueCheckpointSecret(tenantId, checkpointId);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.qrPayload).toBe(`JWK1.${checkpointId}.${a.token}`);
    expect(parseCheckpointPayload(a.qrPayload)).toEqual({
      checkpointId,
      token: a.token,
    });
    expect(a.tokenHash).toBe(
      checkpointTokenHash(tenantId, checkpointId, a.token),
    );
  });

  it('matches only the token behind the hash', () => {
    const { tenantId, checkpointId, token, hash } = VECTOR;
    expect(checkpointTokenMatches(hash, tenantId, checkpointId, token)).toBe(
      true,
    );
    expect(
      checkpointTokenMatches(
        hash,
        tenantId,
        checkpointId,
        'r3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
      ),
    ).toBe(false);
    expect(checkpointTokenMatches('ab', tenantId, checkpointId, token)).toBe(
      false,
    );
  });

  it('reads nothing else as a checkpoint', () => {
    const { checkpointId, token } = VECTOR;
    expect(
      parseCheckpointPayload(` ${checkpointPayload(checkpointId, token)} `),
    ).toEqual({ checkpointId, token });
    for (const raw of [
      '',
      `JWR1.${token}`,
      `JWP1.${token}`,
      `JWK1.${token}`,
      `JWK1.${checkpointId}`,
      `JWK1.${checkpointId}.`,
      `JWK1.${checkpointId}.${token}x`,
      `JWK1.not-a-uuid.${token}`,
      `JWK2.${checkpointId}.${token}`,
    ])
      expect(parseCheckpointPayload(raw)).toBeNull();
  });
});
