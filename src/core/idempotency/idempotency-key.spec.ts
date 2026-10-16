import {
  hashedBody,
  parseIdempotencyKey,
  requestHash,
} from './idempotency-key';

describe('Idempotency-Key parsing and request hash', () => {
  it('accepts a UUID and safe keys, rejects the rest with the header field', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey('0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f')).toBe(
      '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f',
    );
    for (const bad of ['short', 'x'.repeat(129), 'has space here', ['a']]) {
      expect(() => parseIdempotencyKey(bad)).toThrow('Invalid Idempotency-Key');
    }
  });

  it('the hash ignores key order and sees every value', () => {
    const a = requestHash('POST', '/x/:id', { id: '1' }, { a: 1, b: 2 });
    expect(requestHash('POST', '/x/:id', { id: '1' }, { b: 2, a: 1 })).toBe(a);
    expect(requestHash('POST', '/x/:id', { id: '1' }, { a: 1, b: 3 })).not.toBe(
      a,
    );
    expect(requestHash('POST', '/x/:id', { id: '2' }, { a: 1, b: 2 })).not.toBe(
      a,
    );
    expect(requestHash('POST', '/y/:id', { id: '1' }, { a: 1, b: 2 })).not.toBe(
      a,
    );
  });

  it('leaves the omitted fields out of the hash, and nothing else (ADR 0049)', () => {
    const omit = ['idLast4'];
    const hash = (body: object) =>
      requestHash(
        'POST',
        '/p/:id/workers',
        { id: '1' },
        hashedBody(body, omit),
      );
    const a = hash({ fullName: 'A', idLast4: '1234' });
    // No value of the omitted field can be told from the hash.
    for (let n = 0; n < 10_000; n += 1)
      expect(hash({ fullName: 'A', idLast4: String(n).padStart(4, '0') })).toBe(
        a,
      );
    expect(hash({ fullName: 'B', idLast4: '1234' })).not.toBe(a);
    expect(hashedBody({ a: 1, idLast4: '1' }, omit)).toEqual({ a: 1 });
    expect(hashedBody({ a: 1 }, [])).toEqual({ a: 1 });
    expect(hashedBody(undefined, omit)).toBeUndefined();
    expect(hashedBody([1, 2], omit)).toEqual([1, 2]);
  });
});
