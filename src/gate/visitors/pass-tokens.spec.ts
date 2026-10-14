import { ConfigService } from '@nestjs/config';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import { derivePassToken, PassTokens } from './pass-tokens';

const KEY = 'k'.repeat(48);
const config = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

describe('PassTokens (ADR 0043)', () => {
  const hasher = new IdentifierHasher(
    config({ IDENTIFIER_PEPPER: 'p'.repeat(48) }) as never,
  );
  const tokens = new PassTokens(
    config({ VISITOR_PASS_TOKEN_KEY: KEY }) as never,
    hasher,
    new AccessTokens(hasher),
  );
  const T = '00000000-0000-7000-8000-000000000001';
  const P = '00000000-0000-7000-8000-000000000002';

  it('derives a 43-character token per (compound, pass, seq)', () => {
    const t = derivePassToken(KEY, T, P, 0);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(derivePassToken(KEY, T, P, 0)).toBe(t);
    expect(derivePassToken(KEY, T, P, 1)).not.toBe(t);
    expect(derivePassToken(KEY, P, T, 0)).not.toBe(t);
    expect(derivePassToken('x'.repeat(48), T, P, 0)).not.toBe(t);
  });

  it('shows the live secret only while it matches the stored hash', () => {
    const s = tokens.secretOf(T, P, 3);
    expect(s.code).toMatch(/^\d{6}$/);
    const pass = { tenantId: T, id: P, tokenSeq: 3, codeHash: s.codeHash };
    expect(tokens.liveSecret(pass)).toEqual(s);
    expect(tokens.liveSecret({ ...pass, tokenSeq: null })).toBeNull();
    expect(tokens.liveSecret({ ...pass, codeHash: null })).toBeNull();
    expect(tokens.liveSecret({ ...pass, codeHash: 'f'.repeat(64) })).toBeNull();
  });
});
