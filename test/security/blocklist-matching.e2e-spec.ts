import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { permitHelpers } from '../setup/permits';
import {
  securityOpsHelpers,
  type BlocklistBody,
  type Who,
} from '../setup/security-ops';

interface Match {
  kind: string;
  source: string;
  outcome: string;
  subjectType: string | null;
  subjectId: string | null;
  gate: { id: string } | null;
  actor: { id: string };
}

/**
 * ADR 0053: the blocklist wherever a plate or a full ID number is recorded
 * or looked up at the gate. A ban refuses (ENTRY_BLOCKED, verify's
 * entry_blocked) and tells the keepers; a watch lets in and tells them. A
 * resident who records a listed plate learns nothing; a host whose visitor
 * was refused learns, once, that security refused them — never why. Every
 * match is in the keepers' log.
 */
describe('Blocklist — matched at the gate', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };
  let n = 0;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Blocklist Match Court');
    guard = await x.guardOnDuty(s.c);
  }, 120_000);

  afterAll(() => h.close());

  /** A plate nobody else in the suite uses. */
  const plate = () => `BM ${++n}${Date.now() % 1000}`;
  const kinds = async (who: Who, id: string) =>
    (await x.told(s.c, who.id, id)).map((m) => m.kind);
  const matchesOf = async (id: string) =>
    (
      (
        await x
          .http(
            'get',
            `/staff/security/blocklist/${id}/matches`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: Match[] }
    ).data.reverse();
  const lift = (id: string) =>
    x
      .http('post', `/staff/security/blocklist/${id}/lift`, s.manager.token, {
        reasonCode: 'resolved',
      })
      .expect(200);

  it('a banned plate on a pass: the resident learns nothing; the gate refuses it; the host is told once, never why', async () => {
    const p = plate();
    const ban = await x.block(s.manager, { subject: 'plate', plate: p });
    const pass = await x.passWithCode(s.alice, s.home.id, { vehiclePlate: p });
    expect(leakText(pass)).not.toMatch(/ban|block/i);
    const verified = await x.verifyRaw(guard, { code: pass.code }).expect(200);
    expect(verified.body).toMatchObject({
      result: 'invalid',
      reason: 'entry_blocked',
      next: null,
      display: { blocklist: { entryId: ban.id, kind: 'ban' } },
    });
    await x
      .entryRaw(guard, 'visitor_pass', pass.id)
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ code: 'ENTRY_BLOCKED' }));
    expect(await x.told(s.c, s.alice.id, pass.id)).toEqual([
      { kind: 'visitor_pass.refused_by_security', params: {} },
    ]);
    const detail = await x
      .http('get', `/visitor-passes/${pass.id}`, s.alice.token)
      .expect(200);
    expect(detail.body).toMatchObject({ refusedBySecurity: true });
    expect(leakText(detail.body)).not.toContain(ban.id);
    expect(await kinds(s.manager, ban.id)).toEqual([
      'blocklist.ban_matched',
      'blocklist.ban_matched',
      'blocklist.ban_matched',
    ]);
    expect(
      (await matchesOf(ban.id)).map((m) => [m.source, m.outcome, m.subjectId]),
    ).toEqual([
      ['visitor_pass', 'noted', pass.id],
      ['verify', 'refused', pass.id],
      ['entry', 'refused', pass.id],
    ]);
    // Lifted: the visitor comes in.
    await lift(ban.id);
    await x.entryRaw(guard, 'visitor_pass', pass.id).expect(201);
  });

  it('a watched plate: let in, flagged to the guard, the keepers told; the host told nothing', async () => {
    const p = plate();
    const watch = await x.block(s.manager, {
      subject: 'plate',
      plate: p,
      kind: 'watch',
    });
    const pass = await x.passWithCode(s.alice, s.home.id, { vehiclePlate: p });
    const verified = await x.verifyRaw(guard, { code: pass.code }).expect(200);
    expect(verified.body).toMatchObject({
      result: 'valid',
      next: 'in',
      display: { blocklist: { entryId: watch.id, kind: 'watch' } },
    });
    await x.entryRaw(guard, 'visitor_pass', pass.id).expect(201);
    expect(await kinds(s.alice, pass.id)).toEqual([]);
    expect(await kinds(s.manager, watch.id)).toEqual([
      'blocklist.watch_matched',
      'blocklist.watch_matched',
      'blocklist.watch_matched',
    ]);
    expect(
      (await matchesOf(watch.id)).map((m) => [m.source, m.outcome]),
    ).toEqual([
      ['visitor_pass', 'noted'],
      ['verify', 'flagged'],
      ['entry', 'flagged'],
    ]);
  });

  it('the plate lookup names the entries and refuses whoever a ban names', async () => {
    const p = plate();
    const ban = await x.block(s.manager, { subject: 'plate', plate: p });
    await x.passWithCode(s.alice, s.home.id, { vehiclePlate: p });
    const res = await x
      .http('post', '/gate/plate-lookup', guard.token, { plate: p })
      .expect(200);
    expect(res.body).toMatchObject({
      blocklist: [{ entryId: ban.id, kind: 'ban' }],
      matches: [
        expect.objectContaining({
          kind: 'visitor_pass',
          pass: expect.objectContaining({
            valid: false,
            refusal: 'entry_blocked',
          }) as unknown,
        }),
      ],
    });
    expect((await matchesOf(ban.id)).at(-1)).toMatchObject({
      source: 'plate_lookup',
      outcome: 'noted',
      gate: { id: guard.gateId },
      actor: { id: guard.id },
    });
  });

  it('a gate request: a banned plate or ID is refused before the household is asked; a watched one is asked as any, its plate kept with the visitor', async () => {
    const p = plate();
    const ban = await x.block(s.manager, { subject: 'plate', plate: p });
    const person = await x.block(s.manager, {
      subject: 'person',
      fullName: 'Gate Banned',
      idNumber: 'G7788990',
    });
    const ask = (body: Record<string, unknown>) =>
      x.http('post', '/gate/approval-requests', guard.token, {
        kind: 'uninvited_visitor',
        unitCode: s.home.code,
        visitorName: 'Walk In',
        ...body,
      });
    const before = await x.notifications(s.c, s.alice.id);
    for (const body of [{ vehiclePlate: p }, { idNumber: 'g 778 899 0' }])
      await ask(body)
        .expect(409)
        .expect((r) => expect(r.body).toMatchObject({ code: 'ENTRY_BLOCKED' }));
    expect(await x.notifications(s.c, s.alice.id)).toHaveLength(before.length);
    expect((await matchesOf(ban.id)).at(-1)).toMatchObject({
      source: 'gate_request',
      outcome: 'refused',
      subjectId: null,
    });
    expect((await matchesOf(person.id)).at(-1)).toMatchObject({
      source: 'gate_request',
      outcome: 'refused',
    });
    // Watched: asked as any.
    const w = plate();
    const watch = await x.block(s.manager, {
      subject: 'plate',
      plate: w,
      kind: 'watch',
    });
    const made = await ask({ vehiclePlate: w }).expect(201);
    const id = (made.body as { id: string }).id;
    expect((await matchesOf(watch.id)).at(-1)).toMatchObject({
      source: 'gate_request',
      outcome: 'flagged',
      subjectType: 'gate_request',
      subjectId: id,
    });
    const details = await x.inTx(s.c, async (tx) =>
      tx.visitorDetails.findUniqueOrThrow({
        where: {
          id: (
            await tx.gateApprovalRequest.findUniqueOrThrow({ where: { id } })
          ).visitorDetailsId!,
        },
      }),
    );
    expect(details.vehiclePlate).toBe(w);
    // A plate that is not one, an ID that is not one.
    await ask({ vehiclePlate: 'AB-12' }).expect(400);
    await ask({ idNumber: '12' }).expect(400);
  });

  it('the ID lookup: a listed person by their number however typed, with name and face; audited by ids, never the number', async () => {
    const face = await x.photo(s.manager);
    const person = await x.block(s.manager, {
      subject: 'person',
      fullName: 'Lookup Person',
      idNumber: '29001011299887',
      photoFileId: face,
    });
    const res = await x
      .http('post', '/gate/id-lookup', guard.token, {
        idNumber: '٢٩٠٠١٠١ ١٢٩٩٨٨٧',
      })
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as { matches: BlocklistBody[] };
    expect(body.matches).toEqual([
      expect.objectContaining({
        id: person.id,
        kind: 'ban',
        fullName: 'Lookup Person',
      }),
    ]);
    expect(body.matches[0].photo?.url).toEqual(expect.any(String));
    const none = await x
      .http('post', '/gate/id-lookup', guard.token, {
        idNumber: '29001011200001',
      })
      .expect(200);
    expect(none.body).toEqual({ matches: [] });
    const rows = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate.id_lookup',
      targetId: guard.shiftId,
    });
    expect(rows.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { entryIds: [person.id], matches: 1 },
        { entryIds: [], matches: 0 },
      ]),
    );
    expect(leakText(rows)).not.toMatch(/1299887|1200001/);
    await x
      .http('post', '/gate/id-lookup', guard.token, { idNumber: 'x' })
      .expect(400);
    const offShift = await x.guard(s.c);
    await x
      .http('post', '/gate/id-lookup', offShift.token, {
        idNumber: '29001011299887',
      })
      .expect(403);
    await x
      .http('post', '/gate/id-lookup', s.manager.token, {
        idNumber: '29001011299887',
      })
      .expect(403);
  });

  it('an event guest’s banned car: the event is made; the guest is refused at the gate and the requester told once', async () => {
    const p = permitHelpers(h);
    const c = await p.setUp('Blocklist Event Court');
    const atGate = await p.guardOnDuty(c.c);
    const banned = 'EVB 4411';
    await p
      .http('post', '/staff/security/blocklist', c.manager.token, {
        kind: 'ban',
        subject: 'plate',
        plate: banned,
        reasonCode: 'other',
      })
      .expect(201);
    const event = await p.event(c.alice, c.home.id, 2, {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      guests: [
        { fullName: 'Banned Car', vehiclePlate: banned },
        { fullName: 'Fine Car', vehiclePlate: 'EVB 0001' },
      ],
    });
    const [carBanned, carFine] = event.event!.guests;
    for (let i = 0; i < 2; i++)
      await p
        .http('post', '/gate/entries', atGate.token, {
          subjectType: 'event_guest',
          subjectId: carBanned.id,
          direction: 'in',
        })
        .expect(409)
        .expect((r) => expect(r.body).toMatchObject({ code: 'ENTRY_BLOCKED' }));
    await p
      .http('post', '/gate/entries', atGate.token, {
        subjectType: 'event_guest',
        subjectId: carFine.id,
        direction: 'in',
      })
      .expect(201);
    expect(await p.told(c.c, c.alice.id, event.id)).toEqual(
      expect.arrayContaining([
        { kind: 'unit_permit.refused_by_security', params: {} },
      ]),
    );
    expect(
      (await p.told(c.c, c.alice.id, event.id)).filter(
        (t) => t.kind === 'unit_permit.refused_by_security',
      ),
    ).toHaveLength(1);
  });

  it('the matches are the keepers’ alone', async () => {
    const e = await x.block(s.manager, { subject: 'plate', plate: plate() });
    for (const who of [guard, s.alice])
      await x
        .http('get', `/staff/security/blocklist/${e.id}/matches`, who.token)
        .expect(403);
  });
});
