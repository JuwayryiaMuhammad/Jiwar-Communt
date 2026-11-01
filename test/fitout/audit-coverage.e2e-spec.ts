import { ResidentsService } from '../../src/community/residents/residents.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  DEBRIS_MISSED_SWEEP,
  MISSED_AFTER_MS,
} from '../../src/gate/permits/fitout/debris-slots.service';
import { auditReaders } from '../setup/audit';
import { FITOUT_COVERAGE } from '../setup/audit-coverage-split';
import { dbClock } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { financeHelpers } from '../setup/finance';
import { uniqueSuffix } from '../setup/fixtures';
import { damageClaimRow, debrisSlotRow } from '../setup/fitout-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, workDaysOf, type PermitSetUp } from '../setup/permits';

const MARKER = 'AUDIT-fitout-secret';

/**
 * One scenario per entry of the fit-out's catalog (ADR 0014, 0074): the
 * actor, the target, and metadata of ids, codes, days, counts and amounts
 * — never what a resident or a staff member wrote.
 */
const covered = new Set<string>();

describe('Audit coverage — fit-out completion', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let f: ReturnType<typeof financeHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: PermitSetUp;
  let permitId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    f = financeHelpers(h);
    read = auditReaders(h);
    s = await p.setUp('Fit-out Audit Court');
    const permit = await p.works(s.alice, s.home.id);
    await p.approve(s.manager, permit.id);
    permitId = permit.id;
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }
  const http = (
    method: 'get' | 'post',
    path: string,
    token: string,
    body?: object,
  ) => p.http(method, path, token, body);
  type Fit = {
    drawings: { id: string }[];
    debrisSlots: { id: string; scheduledSide: string }[];
    areas: { before: { id: string } | null }[];
    claims: { id: string }[];
  };

  it('permit_drawing.added and .removed — the permit, the drawing, how many now', async () => {
    const added = (
      await http('post', `/permits/${permitId}/drawings`, s.alice.token, {
        fileId: await p.files.ready(s.alice.token, 'permit_drawing'),
      }).expect(201)
    ).body as Fit;
    const drawingId = added.drawings[0].id;
    const rows = await read.tenant(s.c.tenantId, {
      action: 'permit_drawing.added',
      targetId: permitId,
    });
    expect(rows).toHaveLength(1);
    covered.add('permit_drawing.added');
    expect(rows[0]).toMatchObject({
      actorId: s.alice.id,
      metadata: { permitId, drawingId, drawings: 1 },
    });
    await http(
      'post',
      `/permits/${permitId}/drawings/${drawingId}/remove`,
      s.alice.token,
    ).expect(200);
    expect(await single('permit_drawing.removed', permitId)).toMatchObject({
      actorId: s.alice.id,
      metadata: { permitId, drawingId, drawings: 0 },
    });
  });

  it('debris_slot.scheduled, .cancelled, .done and .missed — the day, the window, the side and the code', async () => {
    const day = workDaysOf(await p.rules(s.alice), 1, 1)[0];
    const made = (
      await http('post', `/permits/${permitId}/debris-slots`, s.alice.token, {
        day,
        window: { from: '10:00', to: '11:00' },
      }).expect(201)
    ).body as Fit;
    const slot = made.debrisSlots[0].id;
    expect(await single('debris_slot.scheduled', slot)).toMatchObject({
      actorId: s.alice.id,
      metadata: { permitId, day, from: '10:00', to: '11:00', side: 'resident' },
    });
    await http(
      'post',
      `/permits/${permitId}/debris-slots/${slot}/cancel`,
      s.alice.token,
      { reasonCode: 'plans_changed' },
    ).expect(200);
    expect(await single('debris_slot.cancelled', slot)).toMatchObject({
      actorId: s.alice.id,
      metadata: { permitId, side: 'resident', reasonCode: 'plans_changed' },
    });
    const due = await p.v.inTx(s.c, (tx) =>
      debrisSlotRow(tx, {
        tenantId: s.c.tenantId,
        permitId,
        scheduledBy: s.manager.id,
      }),
    );
    await http(
      'post',
      `/staff/unit-permits/${permitId}/debris-slots/${due}/done`,
      s.manager.token,
    ).expect(200);
    expect(await single('debris_slot.done', due)).toMatchObject({
      actorId: s.manager.id,
      metadata: { permitId, side: 'staff' },
    });
    const ended = new Date(dbClock().getTime() - MISSED_AFTER_MS - 60_000);
    const late = await p.v.inTx(s.c, (tx) =>
      debrisSlotRow(tx, {
        tenantId: s.c.tenantId,
        permitId,
        scheduledBy: s.manager.id,
        startsAt: new Date(ended.getTime() - 3_600_000),
        endsAt: ended,
      }),
    );
    await h.moduleRef.get(SweepRunner).run(DEBRIS_MISSED_SWEEP, dbClock());
    expect(await single('debris_slot.missed', late)).toMatchObject({
      metadata: { permitId },
    });
  });

  it('area_record.recorded — the area, the stage, how many photos, whether there was a note', async () => {
    const area = (
      await http('post', '/maintenance/areas', s.manager.token, {
        kind: 'area',
        code: `AU-${uniqueSuffix()}`,
        nameAr: 'المدخل',
        nameEn: 'Lobby',
      }).expect(201)
    ).body as { id: string };
    const made = (
      await http(
        'post',
        `/staff/unit-permits/${permitId}/area-records`,
        s.manager.token,
        {
          commonAreaId: area.id,
          phase: 'before',
          photoFileIds: [await p.files.ready(s.manager.token, 'fitout_photo')],
          note: MARKER,
        },
      ).expect(201)
    ).body as Fit;
    expect(
      await single('area_record.recorded', made.areas[0].before!.id),
    ).toMatchObject({
      actorId: s.manager.id,
      metadata: {
        permitId,
        commonAreaId: area.id,
        phase: 'before',
        photos: 1,
        note: true,
      },
    });
  });

  it('damage_claim.raised, .appealed, .appeal_decided, .withdrawn, .settled and .appeal_cleared — codes, amounts, never the words', async () => {
    const raise = async () =>
      (
        (
          await http(
            'post',
            `/staff/unit-permits/${permitId}/damage-claims`,
            s.manager.token,
            {
              reasonCode: 'lift_damage',
              description: MARKER,
              amount: '400',
              photoFileIds: [
                await p.files.ready(s.manager.token, 'fitout_photo'),
              ],
            },
          ).expect(201)
        ).body as Fit
      ).claims[0].id;
    const first = await raise();
    expect(await single('damage_claim.raised', first)).toMatchObject({
      actorId: s.manager.id,
      metadata: {
        permitId,
        unitId: s.home.id,
        reasonCode: 'lift_damage',
        amount: '400.00',
        photos: 1,
      },
    });
    await http(
      'post',
      `/permits/${permitId}/damage-claims/${first}/appeal`,
      s.alice.token,
      {
        text: MARKER,
        photoFileId: await p.files.ready(s.alice.token, 'damage_appeal_photo'),
      },
    ).expect(200);
    expect(await single('damage_claim.appealed', first)).toMatchObject({
      actorId: s.alice.id,
      metadata: { permitId, photo: true },
    });
    await http(
      'post',
      `/staff/unit-permits/${permitId}/damage-claims/${first}/appeal-decision`,
      s.manager.token,
      { decision: 'upheld' },
    ).expect(200);
    expect(await single('damage_claim.appeal_decided', first)).toMatchObject({
      actorId: s.manager.id,
      metadata: { permitId, decision: 'upheld' },
    });
    await f.stepUp(s.manager.token);
    await http(
      'post',
      `/staff/unit-permits/${permitId}/damage-claims/${first}/settle`,
      s.manager.token,
    ).expect(200);
    expect(await single('damage_claim.settled', first)).toMatchObject({
      actorId: s.manager.id,
      metadata: { permitId, deducted: '400.00', charged: '0.00' },
    });
    const second = await raise();
    await http(
      'post',
      `/staff/unit-permits/${permitId}/damage-claims/${second}/withdraw`,
      s.manager.token,
      { reasonCode: 'other' },
    ).expect(200);
    expect(await single('damage_claim.withdrawn', second)).toMatchObject({
      actorId: s.manager.id,
      metadata: { permitId, reasonCode: 'other' },
    });
    // The appellant's erasure: on a compound of its own, no deposit held.
    const e = await p.setUp('Fit-out Audit Erased Court');
    await p.setRules(e.manager, { worksDepositRequired: false });
    const created = await p.v.x.resident(e.c, [e.home.id]);
    const permit = await p.works(e.alice, e.home.id);
    await p.approve(e.manager, permit.id);
    const claim = await p.v.inTx(e.c, (tx) =>
      damageClaimRow(tx, {
        tenantId: e.c.tenantId,
        permitId: permit.id,
        unitId: e.home.id,
        raisedBy: e.manager.id,
      }),
    );
    await http(
      'post',
      `/permits/${permit.id}/damage-claims/${claim}/appeal`,
      e.alice.token,
      { text: MARKER },
    ).expect(200);
    await p.v.x.asManager(e.c, () =>
      h.moduleRef.get(ResidentsService).setPrimary(e.home.id, created.id),
    );
    await eraseNow(h, e.c, e.alice.id);
    const rows = await read.tenant(e.c.tenantId, {
      action: 'damage_claim.appeal_cleared',
      targetId: claim,
    });
    expect(rows).toHaveLength(1);
    covered.add('damage_claim.appeal_cleared');
    expect(rows[0]).toMatchObject({
      metadata: { permitId: permit.id, photo: false },
    });
  });

  describe('catalog completeness', () => {
    it('every fit-out entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of FITOUT_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...FITOUT_COVERAGE].sort());
    });
  });
});
