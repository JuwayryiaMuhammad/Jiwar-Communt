import { issueTag, parseTag, tagMatches, tagTokenHash } from './tag-tokens';

const tenant = '0190a2b4-0000-7000-8000-000000000001';
const id = '0190a2b4-0000-7000-8000-0000000000aa';

describe('asset and area tags (ADR 0064)', () => {
  it('an asset tag is JWA1, an area tag JWL1, and each parses back', () => {
    const asset = issueTag('asset', tenant, id);
    const area = issueTag('area', tenant, id);
    expect(asset.code.startsWith(`JWA1.${id}.`)).toBe(true);
    expect(area.code.startsWith(`JWL1.${id}.`)).toBe(true);
    const token = asset.code.slice(`JWA1.${id}.`.length);
    expect(parseTag(`  JWA1.${id.toUpperCase()}.${token} `)).toEqual({
      kind: 'asset',
      id,
      token,
    });
    expect(parseTag(area.code)?.kind).toBe('area');
  });

  it('the hash matches its own token only, per kind, compound and id', () => {
    const tag = issueTag('asset', tenant, id);
    const { token } = parseTag(tag.code)!;
    expect(tagMatches(tag.tokenHash, 'asset', tenant, id, token)).toBe(true);
    expect(tagMatches(tag.tokenHash, 'area', tenant, id, token)).toBe(false);
    expect(tagMatches(tag.tokenHash, 'asset', id, id, token)).toBe(false);
    expect(tagMatches(null, 'asset', tenant, id, token)).toBe(false);
    expect(tagTokenHash('asset', tenant, id, token)).toBe(tag.tokenHash);
    // A new tag replaces the hash: the old print no longer matches.
    const next = issueTag('asset', tenant, id);
    expect(tagMatches(next.tokenHash, 'asset', tenant, id, token)).toBe(false);
  });

  it('anything else is not a tag', () => {
    for (const raw of [
      '',
      'JWK1.' + id + '.x',
      'JWA1.' + id,
      'JWA1.not-a-uuid.' + 'a'.repeat(43),
      'JWA1.' + id + '.',
      'JWR1.' + 'a'.repeat(43),
    ])
      expect(parseTag(raw)).toBeNull();
  });
});
