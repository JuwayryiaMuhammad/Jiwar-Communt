import { ConfigService } from '@nestjs/config';
import { AccessTokens, isToken } from './access-token';
import { IdentifierHasher } from './identifier';

const hasher = new IdentifierHasher({
  get: () => 'unit-test-pepper-unit-test-pepper',
} as unknown as ConfigService<never, true>);
const tokens = new AccessTokens(hasher);
const TENANT = '0190a1b2-0000-7000-8000-000000000001';

describe('AccessTokens (ADR 0030)', () => {
  it('issues 32-byte base64url tokens', () => {
    const t = tokens.newToken();
    expect(t).toHaveLength(43);
    expect(isToken(t)).toBe(true);
    expect(tokens.newToken()).not.toBe(t);
  });

  it('derives the same code from the same token, 6 or 8 digits', () => {
    const t = tokens.newToken();
    expect(tokens.codeOf(t, 6)).toMatch(/^\d{6}$/);
    expect(tokens.codeOf(t, 8)).toMatch(/^\d{8}$/);
    expect(tokens.codeOf(t, 6)).toBe(tokens.codeOf(t, 6));
    expect(tokens.codeOf(t, 8)).toBe(tokens.codeOf(t, 8));
  });

  it('spreads codes over the whole range, leading zeros kept', () => {
    const codes = Array.from({ length: 2000 }, () =>
      tokens.codeOf(tokens.newToken(), 6),
    );
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(1990);
  });

  it('binds the QR hash to the compound, the code to nothing but the token', () => {
    const t = tokens.newToken();
    expect(hasher.hashQrToken(TENANT, t)).not.toBe(
      hasher.hashQrToken('0190a1b2-0000-7000-8000-000000000002', t),
    );
    expect(hasher.hashVisitorLink(t)).not.toBe(hasher.hashQrToken(TENANT, t));
  });

  it('formats and parses the QR payload', () => {
    const t = tokens.newToken();
    expect(tokens.qrPayload(t)).toBe(`JWR1.${t}`);
    expect(tokens.parseQr(`  JWR1.${t}\n`)).toBe(t);
  });

  it.each([
    [''],
    ['123456'],
    ['JWR1.'],
    ['JWR2.' + 'a'.repeat(43)],
    ['jwr1.' + 'a'.repeat(43)],
    ['JWR1.' + 'a'.repeat(42)],
    ['JWR1.' + 'a'.repeat(44)],
    ['JWR1.' + 'a'.repeat(42) + '='],
    ['JWR1.' + 'a'.repeat(42) + '+'],
  ])('rejects a malformed QR %j', (raw) => {
    expect(tokens.parseQr(raw)).toBeNull();
  });

  it('a taken code means a new token', async () => {
    const seen: string[] = [];
    const issued = await tokens.issue(TENANT, 6, (code) => {
      seen.push(code);
      return Promise.resolve(seen.length < 3);
    });
    expect(seen).toHaveLength(3);
    expect(issued.code).toBe(seen[2]);
    expect(tokens.codeOf(issued.token, 6)).toBe(issued.code);
    expect(issued.qrHash).toBe(hasher.hashQrToken(TENANT, issued.token));
  });

  it('gives up after 10 taken codes', async () => {
    await expect(
      tokens.issue(TENANT, 8, () => Promise.resolve(true)),
    ).rejects.toThrow('No free access code');
  });
});
