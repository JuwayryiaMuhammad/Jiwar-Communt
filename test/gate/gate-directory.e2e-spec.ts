import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Directory {
  gates: {
    id: string;
    name: string;
    phone: string | null;
    guards: { id: string; firstName?: string | null }[];
  }[];
  zones: {
    zone: { id: string };
    guards: { id: string; firstName?: string | null }[];
  }[];
}

/**
 * ADR 0056, the gate directory: a guard on duty at any post reads the
 * active gates with their gates' phones, and who is on shift at each gate
 * and in each zone, by first name. Never a personal phone or email, never
 * a guard whose shift ended.
 */
describe('Gate — the directory (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Directory Court');
  }, 180_000);

  afterAll(() => h.close());

  const directory = async (as: { token: string }) =>
    (await g.http('get', '/gate/directory', as.token).expect(200))
      .body as Directory;

  it('the gates with their phones; each post’s guards by first name, nothing else of them', async () => {
    await g
      .http('patch', `/gates/${s.guard.gateId}`, s.manager.token, {
        phone: '+201000000777',
      })
      .expect(200);
    const zoneId = (await g.places(s.alice)).clubhouse.id;
    const patrol = await g.guardInZone(s.c, zoneId);
    const d = await directory(patrol);
    const gate = d.gates.find((x) => x.id === s.guard.gateId)!;
    expect(gate.phone).toBe('+201000000777');
    expect(gate.guards.map((x) => x.id)).toEqual([s.guard.id]);
    expect(Object.keys(gate.guards[0]).sort()).toEqual(['firstName', 'id']);
    const zone = d.zones.find((z) => z.zone.id === zoneId)!;
    expect(zone.guards.map((x) => x.id)).toEqual([patrol.id]);
    // Not a phone or an email of anyone in the whole answer.
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/@|"email"|"phone":"\+20(?!1000000777)/);
  });

  it('only a guard on duty reads it; a shift that ended is gone from it', async () => {
    const offDuty = await g.guard(s.c);
    expect(
      (
        (await g.http('get', '/gate/directory', offDuty.token).expect(403))
          .body as { code: string }
      ).code,
    ).toBe('NO_OPEN_SHIFT');
    const leaving = await g.guardAt(s.c, s.guard.gateId);
    expect(
      (await directory(s.guard)).gates
        .find((x) => x.id === s.guard.gateId)!
        .guards.map((x) => x.id),
    ).toContain(leaving.id);
    await g.endRaw(leaving).expect(200);
    expect(
      (await directory(s.guard)).gates
        .find((x) => x.id === s.guard.gateId)!
        .guards.map((x) => x.id),
    ).not.toContain(leaving.id);
  });
});
