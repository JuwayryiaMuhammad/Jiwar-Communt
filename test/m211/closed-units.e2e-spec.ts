import { Client } from 'pg';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { CLOSED_UNIT_ROUNDS_SWEEP } from '../../src/gate/tasks/closed-units.service';
import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import { queuedBehind } from '../setup/held-lock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';
import { required } from '../setup/test-env';

interface ClosedUnitBody {
  unitId: string;
  unitCode: string;
  closedSince: string;
  lastInspection: { taskId: string; outcome: string } | null;
  openRequest: { id: string } | null;
  round: { id: string; status: string; taskId: string | null } | null;
  nextRoundOn: string;
  liveProxies: number;
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

/**
 * ADR 0083: the units in closed mode and their rounds. A round falls due
 * every N days (the gate setting, 30 by default) after the unit closed or
 * was last inspected; it waits in the staff inbox until it is scheduled as
 * a closed-unit inspection task; the task's end settles it.
 */
describe('Closed units and their rounds', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const sweep = () =>
    h.moduleRef.get(SweepRunner).run(CLOSED_UNIT_ROUNDS_SWEEP, dbClock());

  /** A closed unit, closed `days` ago (a superuser's time machine). */
  async function closed(name: string, days = 31) {
    const s = await x.setUp(name);
    const supervisor = await x.supervisor(s.c);
    await x
      .http('post', `/units/${s.home.id}/closed-mode`, s.alice.token, {
        closed: true,
      })
      .expect(204);
    await backdate(s.home.id, days);
    return { ...s, supervisor };
  }
  async function backdate(unitId: string, days: number) {
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role = replica`);
      await db.query(
        `UPDATE units SET closed_since = now() - make_interval(days => $2)
          WHERE id = $1`,
        [unitId, days],
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }
  const list = async (who: Who) =>
    (
      (
        await x
          .http('get', '/staff/security/closed-units', who.token)
          .expect(200)
      ).body as { data: ClosedUnitBody[] }
    ).data;
  const mine = async (who: Who, unitId: string) =>
    (await list(who)).find((u) => u.unitId === unitId)!;
  const schedule = (who: Who, unitId: string, roundId: string, guard: Who) =>
    x.http('post', '/staff/security/tasks', who.token, {
      kind: 'closed_unit_inspection',
      unitId,
      guardId: guard.id,
      roundId,
    });

  it('listed with its next round; the sweep makes the round due once, into the inbox; a guard’s inspection carries it out', async () => {
    const s = await closed('Rounds Court');
    const before = await mine(s.supervisor, s.home.id);
    expect(before).toMatchObject({
      round: null,
      lastInspection: null,
      openRequest: null,
      liveProxies: 0,
    });
    expect(Object.keys(before).sort()).toEqual([
      'building',
      'closedSince',
      'lastInspection',
      'liveProxies',
      'nextRoundOn',
      'openRequest',
      'round',
      'unitCode',
      'unitId',
    ]);

    await sweep();
    await sweep();
    const due = (await mine(s.supervisor, s.home.id)).round!;
    expect(due).toMatchObject({ status: 'due', taskId: null });
    const rounds = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'closed_unit_round.due',
    });
    expect(rounds.map((r) => r.targetId)).toEqual([due.id]);
    const inbox = (
      await x
        .http('get', '/staff/inbox?type=closed_unit_round', s.supervisor.token)
        .expect(200)
    ).body as { data: { id: string; unitId: string }[] };
    expect(inbox.data).toContainEqual(
      expect.objectContaining({ id: due.id, unitId: s.home.id }),
    );

    const guard = await x.guard(s.c);
    // An inspection only; never with a request.
    expect(
      (
        await x.http('post', '/staff/security/tasks', s.supervisor.token, {
          kind: 'custom',
          title: 'Look around',
          guardId: guard.id,
          roundId: due.id,
        })
      ).status,
    ).toBe(400);
    const task = (
      await schedule(s.supervisor, s.home.id, due.id, guard).expect(201)
    ).body as { id: string };
    expect((await mine(s.supervisor, s.home.id)).round).toMatchObject({
      id: due.id,
      status: 'scheduled',
      taskId: task.id,
    });
    expect(
      code(await schedule(s.supervisor, s.home.id, due.id, guard)),
    ).toEqual({ status: 409, code: 'CLOSED_UNIT_ROUND_NOT_DUE' });

    const gateId = (await x.g.gate(s.c)).id;
    await x.start(guard, { gateId });
    await x
      .http('post', `/gate/tasks/${task.id}/take`, guard.token)
      .expect(200);
    const photo = await x.files.ready(guard.token, 'guard_task_photo');
    await x
      .http('post', `/gate/tasks/${task.id}/complete`, guard.token, {
        outcome: 'all_clear',
        photoFileIds: [photo],
      })
      .expect(200);
    const after = await mine(s.supervisor, s.home.id);
    expect(after).toMatchObject({
      round: null,
      lastInspection: { taskId: task.id, outcome: 'all_clear' },
    });
    // Inspected today: the next round is N days away, none due now.
    await sweep();
    expect((await mine(s.supervisor, s.home.id)).round).toBeNull();
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'closed_unit_round.done',
        targetId: due.id,
      }),
    ).toHaveLength(1);
  });

  it('the compound’s days between rounds; a cancelled task cancels its round and the sweep makes another due; reopened, a due round is cancelled', async () => {
    const s = await closed('Rounds Rules Court', 10);
    await sweep();
    expect((await mine(s.supervisor, s.home.id)).round).toBeNull();
    await x
      .http('patch', '/staff/gate/settings', s.manager.token, {
        closedUnitRoundDays: 7,
      })
      .expect(200);
    await sweep();
    const first = (await mine(s.supervisor, s.home.id)).round!;
    expect(first.status).toBe('due');

    const guard = await x.guard(s.c);
    const task = (
      await schedule(s.supervisor, s.home.id, first.id, guard).expect(201)
    ).body as { id: string };
    await x
      .http(
        'post',
        `/staff/security/tasks/${task.id}/cancel`,
        s.supervisor.token,
        {
          reasonCode: 'no_longer_needed',
        },
      )
      .expect(200);
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'closed_unit_round.cancelled',
        targetId: first.id,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          reasonCode: 'task_cancelled',
        }) as unknown,
      }),
    ]);
    await sweep();
    const second = (await mine(s.supervisor, s.home.id)).round!;
    expect(second.id).not.toBe(first.id);

    await x
      .http('post', `/units/${s.home.id}/closed-mode`, s.alice.token, {
        closed: false,
      })
      .expect(204);
    await sweep();
    expect(await mine(s.supervisor, s.home.id)).toBeUndefined();
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'closed_unit_round.cancelled',
        targetId: second.id,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          reasonCode: 'unit_reopened',
        }) as unknown,
      }),
    ]);
  });

  it('only for guard_tasks.manage', async () => {
    const s = await x.setUp('Rounds Access Court');
    expect(
      (await x.http('get', '/staff/security/closed-units', s.alice.token))
        .status,
    ).toBe(403);
    expect(
      (
        await x.http(
          'get',
          '/staff/security/closed-units',
          (await x.guard(s.c)).token,
        )
      ).status,
    ).toBe(403);
  });

  it('race: two schedulings of one round — one task carries it out, the other is refused', async () => {
    const s = await closed('Rounds Race Court');
    await sweep();
    const due = (await mine(s.supervisor, s.home.id)).round!;
    const a = await x.guard(s.c);
    const b = await x.guard(s.c);
    const answers = await queuedBehind(
      {
        sql: 'SELECT id FROM closed_unit_rounds WHERE id = $1 FOR UPDATE',
        params: [due.id],
      },
      [
        () => schedule(s.supervisor, s.home.id, due.id, a),
        () => schedule(s.supervisor, s.home.id, due.id, b),
      ],
    );
    expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
    const tasks = await x.v.x.asManager(s.c, () =>
      x.v.x.prisma.tenant.guardTask.count({
        where: { unitId: s.home.id, kind: 'closed_unit_inspection' },
      }),
    );
    expect(tasks).toBe(1);
  });
});
