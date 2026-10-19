import { longTag, newSalt, shortTag } from './offline-tags';

/**
 * Computed independently (Python's hmac and hashlib): ADR 0057 and the
 * apps' notes repeat them for the device's tests.
 */
const SALT = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const BUNDLE = '01a102b6-6253-74a0-92b1-a0c4e5f60718';

describe('the bundle’s tags (ADR 0057)', () => {
  it.each([
    ['visitor-code', '482913', 'I3qtK8_tJZJFMXIDorsdCA'],
    ['worker-code', '07315528', 'jSC_IDKzOuLTrjGTa8BtpQ'],
    ['plate', 'قبط1234', 'oPM3-HUXHVf9hkZWL_nF1A'],
    ['guest-name', 'مريم احمد', '0aKVKqV3D3Lk8wOgCxcyag'],
  ] as const)('a short %s tag, keyed with the salt', (kind, value, tag) => {
    expect(SALT.toString('base64url')).toBe(
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
    expect(shortTag(SALT, kind, value)).toBe(tag);
  });

  it.each([
    [
      'visitor-qr',
      'q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
      'fg7EIPpdDfZsNjjurCumYw',
    ],
    [
      'resident-credential',
      '01a102b6-6253-74a0-92b1-9b0320a0f082',
      'FFt87NO75HH6EvxevizavQ',
    ],
    [
      'child-card',
      '2c74d8b9cfe5563fd20d0eab68e87c05e3cf6e86720d164659e7fba8ac5055f6',
      'wNJTVMHiozNEvm6M5vEaCg',
    ],
  ] as const)('a long %s tag, labelled with the bundle', (kind, value, tag) => {
    expect(longTag(BUNDLE, kind, value)).toBe(tag);
  });

  it('another salt, bundle or kind: another tag', () => {
    const tag = shortTag(SALT, 'visitor-code', '482913');
    expect(shortTag(newSalt(), 'visitor-code', '482913')).not.toBe(tag);
    expect(shortTag(SALT, 'worker-code', '482913')).not.toBe(tag);
    const qr = longTag(BUNDLE, 'visitor-qr', 'x');
    expect(longTag(BUNDLE, 'worker-qr', 'x')).not.toBe(qr);
    expect(
      longTag('01a102b6-6253-74a0-92b1-a0c4e5f60719', 'visitor-qr', 'x'),
    ).not.toBe(qr);
  });

  it('16 bytes in base64url, 22 characters', () => {
    expect(shortTag(newSalt(), 'plate', 'X')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(longTag(BUNDLE, 'worker-qr', 'X')).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
