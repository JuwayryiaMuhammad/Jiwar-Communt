import {
  CHILD_CARD_PREFIX,
  childCardHash,
  childCardMatches,
  issueChildCard,
  parseChildCard,
} from './child-tokens';

/**
 * A fixed vector, computed independently (Python's hashlib): ADR 0054
 * repeats it for the app's tests.
 */
const VECTOR = {
  tenantId: '01a102b6-6253-74a0-92b1-96e7c9d52601',
  token: 'q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
  hash: '2c74d8b9cfe5563fd20d0eab68e87c05e3cf6e86720d164659e7fba8ac5055f6',
};

describe('child card tokens (ADR 0054)', () => {
  it('hash the labelled token with SHA-256, no key involved', () => {
    expect(childCardHash(VECTOR.tenantId, VECTOR.token)).toBe(VECTOR.hash);
  });

  it('a hash belongs to one compound', () => {
    expect(
      childCardHash('01a102b6-6253-74a0-92b1-96e7c9d52602', VECTOR.token),
    ).not.toBe(VECTOR.hash);
  });

  it('issues a JWC1 payload whose token hashes to the stored hash', () => {
    const card = issueChildCard(VECTOR.tenantId);
    expect(card.qrPayload.startsWith(CHILD_CARD_PREFIX)).toBe(true);
    const token = parseChildCard(card.qrPayload);
    expect(token).not.toBeNull();
    expect(childCardHash(VECTOR.tenantId, token!)).toBe(card.tokenHash);
    expect(childCardMatches(card.tokenHash, VECTOR.tenantId, token!)).toBe(
      true,
    );
  });

  it('parses only a JWC1 payload with a token, spaces ignored', () => {
    expect(parseChildCard(` ${CHILD_CARD_PREFIX}${VECTOR.token} `)).toBe(
      VECTOR.token,
    );
    for (const raw of [
      VECTOR.token,
      `JWR1.${VECTOR.token}`,
      `JWP1.${VECTOR.token}`,
      `${CHILD_CARD_PREFIX}short`,
      `${CHILD_CARD_PREFIX}${VECTOR.token}x`,
      '',
    ])
      expect(parseChildCard(raw)).toBeNull();
  });

  it('a wrong token or compound never matches', () => {
    expect(
      childCardMatches(
        VECTOR.hash,
        VECTOR.tenantId,
        'r3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
      ),
    ).toBe(false);
    expect(
      childCardMatches(
        VECTOR.hash,
        '01a102b6-6253-74a0-92b1-96e7c9d52602',
        VECTOR.token,
      ),
    ).toBe(false);
  });
});
