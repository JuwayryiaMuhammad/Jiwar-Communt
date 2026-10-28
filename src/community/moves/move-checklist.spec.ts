import { DERIVED_MOVE_STEPS } from '../../core/moves/move-steps';
import { MOVE_CHECKLIST, manualStep } from './move-checklist';

describe('the move checklist (ADR 0063)', () => {
  it('names every step once per direction, in the shape the CHECK allows', () => {
    for (const d of ['in', 'out'] as const) {
      const keys = [
        ...MOVE_CHECKLIST[d].manual.map((s) => s.key),
        ...MOVE_CHECKLIST[d].derived,
      ];
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(k).toMatch(/^[a-z][a-z_]{1,39}$/);
    }
  });

  it('reads only derived steps a domain registers', () => {
    for (const d of ['in', 'out'] as const)
      for (const s of MOVE_CHECKLIST[d].derived)
        expect(DERIVED_MOVE_STEPS).toContain(s);
  });

  it('pins who ticks what', () => {
    expect(MOVE_CHECKLIST.in.manual).toEqual([
      { key: 'guide_read', side: 'resident' },
      { key: 'keys_received', side: 'management' },
      { key: 'meters_read', side: 'management' },
    ]);
    expect(
      MOVE_CHECKLIST.out.manual.every((s) => s.side === 'management'),
    ).toBe(true);
    expect(MOVE_CHECKLIST.out.derived).toContain('clearance_issued');
    expect(manualStep('out', 'guide_read')).toBeNull();
  });
});
