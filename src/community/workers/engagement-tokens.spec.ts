import { createHmac } from 'node:crypto';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import {
  engagementTokenKeyRing,
  parseEngagementTokenKeys,
} from '../../core/config/engagement-token-keys';
import { deriveEngagementToken, EngagementTokens } from './engagement-tokens';

const KEY_1 = 'engagement-token-key-for-the-test-vector-1!';
const KEY_2 = 'engagement-token-key-for-the-test-vector-2!';
const TENANT = '01a102b6-6253-74a0-92b1-96e7c9d52601';
const ENGAGEMENT = '01a102b6-6253-74a0-92b1-9e2a7f3c5d10';

/** The service under a ring, as the app builds it from its environment. */
function tokensWith(keys: string, version: number) {
  const env: Record<string, unknown> = {
    ENGAGEMENT_TOKEN_KEYS: keys,
    ENGAGEMENT_TOKEN_KEY_VERSION: version,
  };
  const config = { get: (k: string) => env[k] } as never;
  const pepper = { get: () => 'p'.repeat(32) } as never;
  const hasher = new IdentifierHasher(pepper);
  return new EngagementTokens(config, hasher, new AccessTokens(hasher));
}

describe('worker card tokens (ADR 0057)', () => {
  it('derives HMAC-SHA256(key, "engagement:<tenant>:<id>:<seq>") in base64url', () => {
    const expected = createHmac('sha256', KEY_1)
      .update(`engagement:${TENANT}:${ENGAGEMENT}:1`)
      .digest('base64url');
    expect(deriveEngagementToken(KEY_1, TENANT, ENGAGEMENT, 1)).toBe(expected);
    expect(expected).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Another seq, compound, engagement or key: another card.
    for (const other of [
      deriveEngagementToken(KEY_1, TENANT, ENGAGEMENT, 2),
      deriveEngagementToken(KEY_2, TENANT, ENGAGEMENT, 1),
      deriveEngagementToken(KEY_1, ENGAGEMENT, TENANT, 1),
    ])
      expect(other).not.toBe(expected);
  });

  it('a rotation: new cards take the new version, an old card is still derived and live', () => {
    const before = tokensWith(`1:${KEY_1}`, 1);
    const card = before.secretOf(TENANT, ENGAGEMENT, 3)!;
    expect(card.keyVersion).toBe(1);
    const after = tokensWith(`1:${KEY_1},2:${KEY_2}`, 2);
    expect(after.currentVersion).toBe(2);
    const stored = {
      tenantId: TENANT,
      id: ENGAGEMENT,
      tokenSeq: 3,
      tokenKeyVersion: 1,
      accessCodeHash: card.codeHash,
      qrTokenHash: card.qrHash,
    };
    expect(after.liveSecret(stored)).toEqual(card);
    const fresh = after.secretOf(TENANT, ENGAGEMENT, 4)!;
    expect(fresh.keyVersion).toBe(2);
    expect(fresh.token).toBe(
      deriveEngagementToken(KEY_2, TENANT, ENGAGEMENT, 4),
    );
    // A ring that dropped version 1 no longer knows it: not live, never thrown.
    expect(tokensWith(`2:${KEY_2}`, 2).liveSecret(stored)).toBeNull();
  });

  it('a card before ADR 0057, or hashes that no longer match, is not live', () => {
    const t = tokensWith(`1:${KEY_1}`, 1);
    const card = t.secretOf(TENANT, ENGAGEMENT, 1)!;
    const base = {
      tenantId: TENANT,
      id: ENGAGEMENT,
      tokenSeq: 1,
      tokenKeyVersion: 1,
      accessCodeHash: card.codeHash,
      qrTokenHash: card.qrHash,
    };
    expect(
      t.liveSecret({ ...base, tokenSeq: null, tokenKeyVersion: null }),
    ).toBeNull();
    expect(t.liveSecret({ ...base, qrTokenHash: null })).toBeNull();
    expect(
      t.liveSecret({ ...base, accessCodeHash: 'f'.repeat(64) }),
    ).toBeNull();
    expect(t.liveSecret({ ...base, tokenSeq: 2 })).toBeNull();
  });

  describe('the ring', () => {
    it('parses versions and keys, never quoting a key', () => {
      const ring = parseEngagementTokenKeys(`1:${KEY_1}, 7:${KEY_2}`);
      expect(ring).toEqual(
        new Map([
          [1, KEY_1],
          [7, KEY_2],
        ]),
      );
      for (const [value, why] of [
        ['nope', /version/],
        [`0:${KEY_1}`, /version/],
        [`1:short`, /at least 32/],
        [`1:${KEY_1},1:${KEY_2}`, /appears twice/],
        [`1:${KEY_1},2:${KEY_1}`, /repeats another/],
      ] as const) {
        const parsed = parseEngagementTokenKeys(value);
        expect(parsed).toEqual({
          invalid: expect.stringMatching(why) as string,
        });
        expect(JSON.stringify(parsed)).not.toContain(KEY_1);
      }
    });

    it('the current version must be in it', () => {
      expect(() =>
        engagementTokenKeyRing({
          ENGAGEMENT_TOKEN_KEYS: `1:${KEY_1}`,
          ENGAGEMENT_TOKEN_KEY_VERSION: 2,
        }),
      ).toThrow(/not in the ring/);
    });
  });
});
