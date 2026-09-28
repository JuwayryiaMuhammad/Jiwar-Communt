import { ConfigService } from '@nestjs/config';
import {
  IdentifierHasher,
  normalizeEmail,
  normalizePhone,
  parseIdentifier,
} from './identifier';

describe('identifier normalization', () => {
  it('lowercases and trims emails', () => {
    expect(normalizeEmail('  Mona.Ali@Example.COM ')).toBe(
      'mona.ali@example.com',
    );
  });

  it('rejects malformed emails', () => {
    expect(normalizeEmail('not-an-email@')).toBeNull();
  });

  it.each([
    ['01012345678', '+201012345678'],
    ['+20 101 234 5678', '+201012345678'],
    ['00201012345678', '+201012345678'],
    [' 010-1234-5678 ', '+201012345678'],
  ])('normalizes Egyptian phone %s to E.164', (raw, e164) => {
    expect(normalizePhone(raw)).toBe(e164);
  });

  it('keeps foreign numbers in E.164', () => {
    expect(normalizePhone('+971 50 123 4567')).toBe('+971501234567');
  });

  it('rejects invalid phones', () => {
    expect(normalizePhone('12345')).toBeNull();
  });

  it('detects the identifier type', () => {
    expect(parseIdentifier('A@B.co')).toEqual({
      type: 'email',
      value: 'a@b.co',
    });
    expect(parseIdentifier('01012345678')).toEqual({
      type: 'phone',
      value: '+201012345678',
    });
    expect(parseIdentifier('garbage')).toBeNull();
  });
});

describe('IdentifierHasher', () => {
  const hasher = (pepper: string) =>
    new IdentifierHasher({
      get: () => pepper,
    } as unknown as ConfigService<never, true>);

  it('hashes equivalent inputs identically', () => {
    const h = hasher('p'.repeat(32));
    const a = parseIdentifier('01012345678')!;
    const b = parseIdentifier('+20 101 234 5678')!;
    expect(h.hashIdentifier(a)).toBe(h.hashIdentifier(b));
    expect(h.hashIdentifier(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the pepper', () => {
    const id = parseIdentifier('a@b.co')!;
    expect(hasher('p'.repeat(32)).hashIdentifier(id)).not.toBe(
      hasher('q'.repeat(32)).hashIdentifier(id),
    );
  });

  it('binds OTP hashes to the challenge', () => {
    const h = hasher('p'.repeat(32));
    expect(h.hashOtp('c1', '123456')).not.toBe(h.hashOtp('c2', '123456'));
  });
});
