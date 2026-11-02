import { Client } from 'pg';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { CLOSED_UNIT_ROUNDS_SWEEP } from '../../src/gate/tasks/closed-units.service';
import { GROUP_OFFERS_SWEEP } from '../../src/partners/group-offers/group-offers.service';
import { auditReaders } from '../setup/audit';
import { M211_COVERAGE } from '../setup/audit-coverage-split';
import { at, dbClock, day } from '../setup/compound-clock';
import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers } from '../setup/market';
import { securityHelpers } from '../setup/security';
import { required } from '../setup/test-env';

const MARKER = 'AUDIT-m211-secret';

/**
 * One scenario per entry of the transfers', closed units' and market's
 * catalog (ADR 0014, 0083): actor, target, and what changed — codes,
 * amounts, counts and days, never a person's words.
 */
const covered = new Set<string>();

describe('Audit coverage — transfers, closed units, entries and group offers’ contracts', () => {
  let h: HttpHarness;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    read = auditReaders(h);
  }, 90_000);

  afterAll(() => h.close());

  async function single(tenantId: string, action: string, targetId: string) {
    const rows = await read.tenant(tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  async function superuser(sql: string, params: unknown[]) {
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role = replica`);
      await db.query(sql, params);
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }

  it('ownership_transfer.requested, .approved and .cancelled — the unit, the buyer, what was owed and the codes; never the words', async () => {
    const f = financeHelpers(h);
    const s = await f.setUp('Audit Transfer Court');
    const buyer = await f.owner(s.c, (await f.unit(s.c, 'B')).id);
    const ask = async () =>
      (
        await f
          .http(
            'post',
            `/staff/units/${s.home.id}/ownership-transfers`,
            s.manager.token,
            {
              toAccountId: buyer.id,
              reasonCode: 'unit_changed_hands',
              reason: MARKER,
            },
          )
          .expect(201)
      ).body as { id: string };
    const first = await ask();
    expect(
      await single(s.c.tenantId, 'ownership_transfer.requested', first.id),
    ).toMatchObject({
      actorId: s.manager.id,
      targetType: 'ownership_transfer',
      metadata: {
        unitId: s.home.id,
        buyerAccountId: buyer.id,
        resides: true,
        reasonCode: 'unit_changed_hands',
      },
    });
    await f
      .http(
        'post',
        `/staff/ownership-transfers/${first.id}/cancel`,
        s.manager.token,
        { reasonCode: 'documents_missing' },
      )
      .expect(200);
    expect(
      await single(s.c.tenantId, 'ownership_transfer.cancelled', first.id),
    ).toMatchObject({
      metadata: { unitId: s.home.id, reasonCode: 'documents_missing' },
    });
    await f.issue(s.manager, s.home.id);
    const second = await ask();
    await f.stepUp(s.manager.token);
    await f
      .http(
        'post',
        `/staff/ownership-transfers/${second.id}/approve`,
        s.manager.token,
        { duesExceptionCode: 'court_order' },
      )
      .expect(200);
    expect(
      await single(s.c.tenantId, 'ownership_transfer.approved', second.id),
    ).toMatchObject({
      actorId: s.manager.id,
      metadata: {
        unitId: s.home.id,
        owed: '1000.00',
        duesExceptionCode: 'court_order',
        stepUp: true,
        newOccupancyId: expect.any(String) as string,
      },
    });
  });

  it('closed_unit_round.due, .scheduled, .done and .cancelled — the unit, the day, the task and the code', async () => {
    const x = securityHelpers(h);
    const s = await x.setUp('Audit Rounds Court');
    const supervisor = await x.supervisor(s.c);
    await x
      .http('post', `/units/${s.home.id}/closed-mode`, s.alice.token, {
        closed: true,
      })
      .expect(204);
    await superuser(
      `UPDATE units SET closed_since = now() - interval '40 days' WHERE id = $1`,
      [s.home.id],
    );
    const sweep = () =>
      h.moduleRef.get(SweepRunner).run(CLOSED_UNIT_ROUNDS_SWEEP, dbClock());
    const round = async () =>
      x.x.asManager(s.c, () =>
        x.x.prisma.tenant.closedUnitRound.findFirstOrThrow({
          where: { unitId: s.home.id, status: { in: ['due', 'scheduled'] } },
        }),
      );
    await sweep();
    const first = await round();
    expect(
      await single(s.c.tenantId, 'closed_unit_round.due', first.id),
    ).toMatchObject({
      actorId: null,
      targetType: 'closed_unit_round',
      metadata: { unitId: s.home.id, everyDays: 30 },
    });
    const guard = await x.guard(s.c);
    const schedule = async (roundId: string) =>
      (
        await x
          .http('post', '/staff/security/tasks', supervisor.token, {
            kind: 'closed_unit_inspection',
            unitId: s.home.id,
            guardId: guard.id,
            roundId,
          })
          .expect(201)
      ).body as { id: string };
    const task = await schedule(first.id);
    expect(
      await single(s.c.tenantId, 'closed_unit_round.scheduled', first.id),
    ).toMatchObject({
      actorId: supervisor.id,
      metadata: { unitId: s.home.id, taskId: task.id },
    });
    await x
      .http(
        'post',
        `/staff/security/tasks/${task.id}/cancel`,
        supervisor.token,
        {
          reasonCode: 'duplicate',
        },
      )
      .expect(200);
    expect(
      await single(s.c.tenantId, 'closed_unit_round.cancelled', first.id),
    ).toMatchObject({
      metadata: { unitId: s.home.id, reasonCode: 'task_cancelled' },
    });
    await sweep();
    const second = await round();
    const again = await schedule(second.id);
    await x.start(guard, { gateId: (await x.g.gate(s.c)).id });
    await x
      .http('post', `/gate/tasks/${again.id}/take`, guard.token)
      .expect(200);
    await x
      .http('post', `/gate/tasks/${again.id}/complete`, guard.token, {
        outcome: 'all_clear',
        photoFileIds: [await x.files.ready(guard.token, 'guard_task_photo')],
      })
      .expect(200);
    expect(
      await single(s.c.tenantId, 'closed_unit_round.done', second.id),
    ).toMatchObject({
      actorId: guard.id,
      metadata: { unitId: s.home.id, taskId: again.id },
    });
  });

  it('unit_entry.recorded and .reported — the unit, the codes, how many witnesses, photos and people told; never the report’s words', async () => {
    const x = securityHelpers(h);
    const s = await x.setUp('Audit Entry Court');
    const supervisor = await x.supervisor(s.c);
    const witness = await x.guard(s.c);
    const entry = (
      await x
        .http('post', '/staff/security/unit-entries', supervisor.token, {
          unitId: s.home.id,
          reasonCode: 'smoke',
          enteredAt: new Date().toISOString(),
          witnessIds: [witness.id],
        })
        .expect(201)
    ).body as { id: string };
    expect(
      await single(s.c.tenantId, 'unit_entry.recorded', entry.id),
    ).toMatchObject({
      actorId: supervisor.id,
      targetType: 'unit_entry',
      metadata: {
        unitId: s.home.id,
        reasonCode: 'smoke',
        witnesses: 1,
        photos: 0,
        told: 1,
      },
    });
    await x
      .http(
        'post',
        `/staff/security/unit-entries/${entry.id}/report`,
        supervisor.token,
        {
          outcome: 'no_issue_found',
          note: MARKER,
          photoFileIds: [
            await x.files.ready(supervisor.token, 'unit_entry_photo'),
          ],
        },
      )
      .expect(200);
    expect(
      await single(s.c.tenantId, 'unit_entry.reported', entry.id),
    ).toMatchObject({
      metadata: {
        unitId: s.home.id,
        outcome: 'no_issue_found',
        photos: 1,
        told: 1,
      },
    });
  });

  it('group_offer.reconfirm_requested, .reconfirmed and .contracted — the prices, the counts; never a person', async () => {
    const m = marketHelpers(h);
    const s = await m.setUp();
    const offer = (
      await m
        .http('post', '/staff/group-offers', s.manager.token, {
          titleEn: 'Audit filters',
          titleAr: 'فلاتر',
          bodyEn: 'One a home.',
          bodyAr: 'لكل وحدة.',
          listPrice: '1200',
          groupPrice: '950',
          minParticipants: 2,
          closesAt: at(day(5), 20).toISOString(),
        })
        .expect(201)
    ).body as { id: string };
    for (const [who, unitId] of [
      [s.alice, s.homeA.id],
      [s.bob, s.homeB.id],
    ] as const)
      await m
        .http('post', `/market/group-offers/${offer.id}/join`, who.token, {
          unitId,
          quantity: 1,
        })
        .expect(201);
    await m.timeMachine(s.c, offer.id);
    await m.sweep_(GROUP_OFFERS_SWEEP, dbClock());
    await m
      .http(
        'post',
        `/staff/group-offers/${offer.id}/contract`,
        s.manager.token,
        {
          finalPrice: '990',
        },
      )
      .expect(200);
    expect(
      await single(s.c.tenantId, 'group_offer.reconfirm_requested', offer.id),
    ).toMatchObject({
      actorId: s.manager.id,
      metadata: {
        finalPrice: '990.00',
        groupPrice: '950.00',
        asked: 2,
        hours: 72,
      },
    });
    for (const who of [s.alice, s.bob])
      await m
        .http('post', `/market/group-offers/${offer.id}/reconfirm`, who.token)
        .expect(200);
    const reconfirmed = await read.tenant(s.c.tenantId, {
      action: 'group_offer.reconfirmed',
      targetId: offer.id,
    });
    expect(reconfirmed.map((r) => r.actorId).sort()).toEqual(
      [s.alice.id, s.bob.id].sort(),
    );
    covered.add('group_offer.reconfirmed');
    await superuser(
      `UPDATE group_offers SET reconfirm_closes_at = now() - interval '1 second' WHERE id = $1`,
      [offer.id],
    );
    await m.sweep_(GROUP_OFFERS_SWEEP, dbClock());
    expect(
      await single(s.c.tenantId, 'group_offer.contracted', offer.id),
    ).toMatchObject({
      actorId: null,
      metadata: {
        finalPrice: '990.00',
        households: 2,
        quantity: 2,
        dropped: 0,
      },
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the phase has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M211_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M211_COVERAGE].sort());
    });
  });
});
