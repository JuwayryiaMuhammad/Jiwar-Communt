import { createHash } from 'node:crypto';
import {
  deskLink,
  deskTokenHash,
  isDeskToken,
  newDeskToken,
} from './desk-tokens';

describe('desk tokens (ADR 0060)', () => {
  it('are 32 random bytes in base64url, never the same twice', () => {
    const a = newDeskToken();
    const b = newDeskToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('are kept as SHA-256 with a domain label, never bare', () => {
    const token = newDeskToken();
    const hash = deskTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(
      createHash('sha256')
        .update(`jiwar:partner-desk:v1:${token}`)
        .digest('hex'),
    );
    expect(hash).not.toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('are checked for their shape before anything is read', () => {
    expect(isDeskToken(newDeskToken())).toBe(true);
    expect(isDeskToken('short')).toBe(false);
    expect(isDeskToken(`${newDeskToken()}x`)).toBe(false);
    expect(isDeskToken('a'.repeat(42) + '=')).toBe(false);
    expect(isDeskToken(42)).toBe(false);
  });

  it('travel in the fragment of the public page’s link', () => {
    expect(deskLink('https://app.example/', 'T0K')).toBe(
      'https://app.example/p#T0K',
    );
  });
});
