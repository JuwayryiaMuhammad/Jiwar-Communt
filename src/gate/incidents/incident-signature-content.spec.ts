import {
  canonicalJson,
  contentSha256,
  type SignedMaterial,
} from './incident-signature-content';

const T0 = new Date('2026-11-05T08:00:00.000Z');
const material = (
  over: Partial<SignedMaterial['incident']> = {},
  ids: Partial<Omit<SignedMaterial, 'incident'>> = {},
): SignedMaterial => ({
  incident: {
    id: '00000000-0000-7000-8000-000000000001',
    number: 12,
    type: 'hazard',
    severity: 'medium',
    placeId: null,
    unitId: '00000000-0000-7000-8000-0000000000aa',
    occurredAt: T0,
    description: 'A loose cable by the pool',
    reportedById: '00000000-0000-7000-8000-0000000000bb',
    emergencyId: null,
    gateServiceRequestId: null,
    patrolNoteId: null,
    createdAt: new Date(T0.getTime() + 60_000),
    status: 'open',
    outcome: null,
    closingNote: null,
    ...over,
  },
  photoFileIds: ['b', 'a'],
  mediaFileIds: [],
  evidenceIds: [],
  ...ids,
});

describe('incident signature content (ADR 0056)', () => {
  it('canonical JSON sorts keys at every level; instants in ISO, absent as null', () => {
    expect(canonicalJson({ b: 1, a: { d: T0, c: undefined }, e: [2, 1] })).toBe(
      '{"a":{"c":null,"d":"2026-11-05T08:00:00.000Z"},"b":1,"e":[2,1]}',
    );
  });

  it('a hash of 64 lower-case hex digits, the same for the same content in any order of ids', () => {
    const a = contentSha256('author', material());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      contentSha256('author', material({}, { photoFileIds: ['a', 'b'] })),
    ).toBe(a);
  });

  it('closing changes the reviewer’s content, never the author’s', () => {
    const open = material();
    const closed = material({
      status: 'closed',
      outcome: 'resolved',
      closingNote: 'Fixed by maintenance',
    });
    expect(contentSha256('author', closed)).toBe(contentSha256('author', open));
    expect(contentSha256('reviewer', closed)).not.toBe(
      contentSha256('reviewer', open),
    );
    // An assignment moves the status: the reviewer's only.
    const investigating = material({ status: 'investigating' });
    expect(contentSha256('author', investigating)).toBe(
      contentSha256('author', open),
    );
    expect(contentSha256('reviewer', investigating)).not.toBe(
      contentSha256('reviewer', open),
    );
  });

  it('any change inside the author’s scope changes both', () => {
    const base = material();
    for (const changed of [
      material({ description: null }),
      material({ severity: 'high' }),
      material({ occurredAt: new Date(T0.getTime() + 1) }),
      material({ patrolNoteId: '00000000-0000-7000-8000-0000000000cc' }),
      material({}, { evidenceIds: ['e1'] }),
      material({}, { mediaFileIds: ['m1'] }),
      material({}, { photoFileIds: ['a'] }),
    ])
      for (const role of ['author', 'reviewer'] as const)
        expect([role, contentSha256(role, changed)]).not.toEqual([
          role,
          contentSha256(role, base),
        ]);
  });

  it('the two roles never sign the same content', () => {
    expect(contentSha256('author', material())).not.toBe(
      contentSha256('reviewer', material()),
    );
  });
});
