import { CONSENT_CODES } from '../core/consents/consent-catalog';
import { PARTNER_CATEGORIES } from './categories';
import { partnerConsent } from './consents';

describe('partner consents (ADR 0036, 0060)', () => {
  it('every category has its own consent, and the catalog no other partner consent', () => {
    expect(PARTNER_CATEGORIES.map(partnerConsent)).toEqual(
      PARTNER_CATEGORIES.map((c) => `partner_share_${c}`),
    );
    expect(
      CONSENT_CODES.filter((c) => c.startsWith('partner_share_')).sort(),
    ).toEqual(PARTNER_CATEGORIES.map((c) => `partner_share_${c}`).sort());
  });
});
