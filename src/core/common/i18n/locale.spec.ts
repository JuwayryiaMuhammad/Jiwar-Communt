import { resolveLocale } from './locale';

describe('resolveLocale', () => {
  it.each([
    [undefined, 'ar'],
    ['', 'ar'],
    ['en', 'en'],
    ['en-US,en;q=0.9', 'en'],
    ['ar-EG,ar;q=0.9,en;q=0.8', 'ar'],
    ['fr-FR,fr;q=0.9,en;q=0.8', 'en'],
    ['fr,de', 'ar'],
    ['ar;q=0.5,en;q=0.8', 'en'],
    ['en;q=0,ar;q=0.1', 'ar'],
    ['*', 'ar'],
    ['garbage;;;q=x', 'ar'],
  ])('%p → %s', (header, expected) => {
    expect(resolveLocale(header)).toBe(expected);
  });
});
