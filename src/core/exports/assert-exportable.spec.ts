import { assertExportable } from './data-exports.service';

const codeOf = (fn: () => void) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as { response?: { code?: string } }).response?.code;
  }
};

describe('assertExportable', () => {
  it('refuses frozen and erased accounts', () => {
    for (const status of ['frozen', 'erased'])
      for (const assisted of [false, true])
        expect(
          codeOf(() =>
            assertExportable({ status, email: 'a@x.test' }, assisted),
          ),
        ).toBe('ACCOUNT_NOT_ELIGIBLE');
  });

  it('sends an assisted export only to the account’s own email: none, refused', () => {
    expect(
      codeOf(() => assertExportable({ status: 'active', email: null }, true)),
    ).toBe('ACCOUNT_HAS_NO_EMAIL');
    // The account's own request downloads in the app.
    expect(
      codeOf(() => assertExportable({ status: 'active', email: null }, false)),
    ).toBe('ok');
    expect(
      codeOf(() =>
        assertExportable({ status: 'inactive', email: 'a@x.test' }, true),
      ),
    ).toBe('ok');
  });
});
