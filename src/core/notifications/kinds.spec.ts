import {
  checkNotification,
  NOTIFICATION_KINDS,
  PERSONAL_PARAMS,
  type KindSpec,
} from './kinds';

describe('notification catalog', () => {
  const kinds = NOTIFICATION_KINDS as Record<string, KindSpec>;

  it('no param name looks like a document, phone, email or code', () => {
    const names = Object.values(kinds).flatMap((k) => Object.keys(k.params));
    const offenders = names.filter((n) =>
      /document|national|passport|phone|mobile|email|code$|otp|token|secret|password/i.test(
        n.replace(/^unitCode$/, ''),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('kinds are dotted codes with a priority and a target', () => {
    for (const [kind, spec] of Object.entries(kinds)) {
      expect(kind).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(['normal', 'critical']).toContain(spec.priority);
      expect(spec.target).toMatch(/^[a-z_]+$/);
    }
  });

  it('personal params are the visitor and worker names', () => {
    expect(PERSONAL_PARAMS).toEqual(['visitorName', 'workerName']);
  });

  it('rejects unknown kinds, unknown or missing params and non-scalars', () => {
    expect(() => checkNotification('nope.kind', {})).toThrow(/Unknown/);
    const ok = {
      unitCode: 'A-1',
      gateName: 'Main',
      workerName: 'W',
    };
    expect(() => checkNotification('worker.entered', ok)).not.toThrow();
    expect(() =>
      checkNotification('worker.entered', { ...ok, phone: '+20100' }),
    ).toThrow(/no param phone/);
    expect(() =>
      checkNotification('worker.entered', { unitCode: 'A-1', gateName: 'G' }),
    ).toThrow(/needs param workerName/);
    expect(() =>
      checkNotification('worker.entered', {
        ...ok,
        unitCode: { nested: true } as unknown as string,
      }),
    ).toThrow(/scalar/);
  });
});
