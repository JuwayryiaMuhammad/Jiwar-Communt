import { diffChanges } from './diff';
import {
  isSensitiveField,
  looksPersonal,
  PersonalValueError,
  REDACTED,
  sanitize,
  SensitiveKeyError,
} from './personal-data';

describe('diffChanges', () => {
  it('keeps only changed fields, as { from, to }', () => {
    expect(
      diffChanges(
        { status: 'active', type: 'resident', floor: 1 },
        { status: 'inactive', type: 'resident', floor: 1 },
        'account.status_changed',
      ),
    ).toEqual({ status: { from: 'active', to: 'inactive' } });
  });

  it('a creation diffs from null; personal fields become { changed: true }', () => {
    expect(
      diffChanges(
        null,
        {
          type: 'resident',
          fullName: 'Ahmed Mohamed',
          nationalId: '29001010134567',
          phone: '+201012345678',
          email: 'ahmed@example.com',
          status: 'active',
        },
        'account.created',
      ),
    ).toEqual({
      type: { from: null, to: 'resident' },
      fullName: { changed: true },
      nationalId: { changed: true },
      phone: { changed: true },
      email: { changed: true },
      status: { from: null, to: 'active' },
    });
  });

  it('treats secrets by pattern and snake_case names as sensitive', () => {
    expect(
      diffChanges(
        { passwordHash: 'a', full_name: 'x', mustChangePassword: true },
        { passwordHash: 'b', full_name: 'y', mustChangePassword: false },
        'platform_admin.password_changed',
      ),
    ).toEqual({
      passwordHash: { changed: true },
      full_name: { changed: true },
      mustChangePassword: { from: true, to: false },
    });
  });

  it('withholds any password-like field by default; only named exceptions keep values', () => {
    expect(
      diffChanges(
        {
          newPassword: null,
          passwordResetCode: null,
          temporaryPassword: null,
          mustChangePassword: true,
        },
        {
          newPassword: 'n3w-secret-value',
          passwordResetCode: '483920',
          temporaryPassword: 'tmp-value',
          mustChangePassword: false,
        },
        'platform_admin.password_changed',
      ),
    ).toEqual({
      newPassword: { changed: true },
      passwordResetCode: { changed: true },
      temporaryPassword: { changed: true },
      mustChangePassword: { from: true, to: false },
    });
  });

  it('the exception list never overrides an explicitly sensitive field', () => {
    // `email` is always sensitive, even if someone listed it as an exception.
    expect(isSensitiveField('email')).toBe(true);
    expect(isSensitiveField('mustChangePassword')).toBe(false);
    expect(isSensitiveField('must_change_password')).toBe(false);
  });

  it('keeps a compound name readable (only person names are sensitive)', () => {
    expect(diffChanges(null, { name: 'Palm Court' }, 'tenant.created')).toEqual(
      {
        name: { from: null, to: 'Palm Court' },
      },
    );
  });

  it('compares arrays and dates by value', () => {
    const d = new Date('2026-09-29T10:00:00.000Z');
    expect(
      diffChanges(
        { permissions: ['a', 'b'], endedAt: null },
        { permissions: ['a', 'b'], endedAt: d },
        'occupancy.ended',
      ),
    ).toEqual({ endedAt: { from: null, to: '2026-09-29T10:00:00.000Z' } });
  });
});

describe('personal data guard', () => {
  it.each([
    ['ahmed@example.com', 'email'],
    ['write to ahmed@example.com', 'email'],
    ['+201012345678', 'phone'],
    ['01012345678', 'phone'],
    ['29001010134567', 'national id'],
  ])('%s looks like %s', (value, kind) => {
    expect(looksPersonal(value)).toBe(kind);
  });

  it.each([
    '01920000-0000-7000-8000-010123456789',
    'A-101',
    '2026-09-29T10:00:00.000Z',
    'units.read',
    '1234567890',
  ])('%s is fine', (value) => {
    expect(looksPersonal(value)).toBeNull();
  });

  it('a sensitive metadata key always throws, at any depth', () => {
    expect(() =>
      sanitize(
        { ok: 1, nested: { email: 'x' } },
        { checkKeys: true, strict: false, root: 'metadata' },
      ),
    ).toThrow(SensitiveKeyError);
  });

  it('personal-looking values are redacted in production, reported by path', () => {
    const out = sanitize(
      { recipient: 'ahmed@x.com', list: ['A-1', '01012345678'] },
      { checkKeys: true, strict: false, root: 'metadata' },
    );
    expect(out.value).toEqual({ recipient: REDACTED, list: ['A-1', REDACTED] });
    expect(out.redacted).toEqual(['metadata.recipient', 'metadata.list.1']);
  });

  it('personal-looking values throw in strict (test) mode', () => {
    expect(() =>
      sanitize(
        { code: { from: null, to: '01012345678' } },
        { checkKeys: false, strict: true, root: 'changes' },
      ),
    ).toThrow(PersonalValueError);
  });
});
