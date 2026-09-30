import { accountRef, maskDocument } from './personal';

describe('personal data in views', () => {
  it.each([
    ['29001010112222', '••••2222'],
    ['A1234567', '••••4567'],
    ['123', '••••123'],
    [null, null],
  ])('masks %s as %s', (number, masked) => {
    expect(maskDocument(number)).toBe(masked);
  });

  it('renders an erased account as its id only', () => {
    expect(accountRef({ id: 'x', fullName: null, status: 'erased' })).toEqual({
      id: 'x',
      erased: true,
    });
    expect(accountRef({ id: 'y', fullName: 'Mona', status: 'frozen' })).toEqual(
      {
        id: 'y',
        fullName: 'Mona',
      },
    );
  });
});
