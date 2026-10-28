import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

interface RequestBody {
  id: string;
  status: string;
  cancelReason: string | null;
  code?: string;
}

interface ReportBody {
  taskId: string;
  requestId: string | null;
  outcome: string;
  note: string | null;
  photos: { url: string }[];
}

/**
 * A closed unit's inspections (ADR 0063): its owner asks for a visit, the
 * management schedules it as an inspection task, the guard's completion
 * closes it, and the owner reads the report — outcome, note and photos,
 * never the guard's name.
 */
describe('Inspection requests', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
  }, 120_000);

  afterAll(() => h.close());

  type SetUp = Awaited<ReturnType<typeof x.setUp>>;
  const codeOf = (res: { body: unknown }) => (res.body as RequestBody).code;
  const ask = (s: SetUp, who: Who = s.alice, preferredOn = day(3)) =>
    x.http('post', `/units/${s.home.id}/inspection-requests`, who.token, {
      preferredOn,
    });
  const close = (s: SetUp) =>
    x
      .http('post', `/units/${s.home.id}/closed-mode`, s.alice.token, {
        closed: true,
      })
      .expect(204);
  const row = (s: SetUp, id: string) =>
    x.inTx(s.c, (tx) =>
      tx.unitInspectionRequest.findUniqueOrThrow({ where: { id } }),
    );

  it('asked for a closed unit, scheduled as a task, done with it; the owner reads the report without the guard', async () => {
    const s = await x.setUp('Inspection Court');
    const supervisor = await x.supervisor(s.c);
    expect(codeOf(await ask(s))).toBe('INSPECTION_UNIT_NOT_CLOSED');
    await close(s);
    const asked = (await ask(s).expect(201)).body as RequestBody;
    expect(asked.status).toBe('open');
    expect(codeOf(await ask(s))).toBe('INSPECTION_REQUEST_OPEN');
    expect(
      (await x.notifications(s.c, supervisor.id))
        .filter((n) => n.targetId === asked.id)
        .map((n) => ({ kind: n.kind, params: n.params })),
    ).toEqual([
      { kind: 'unit_inspection.requested', params: { preferredOn: day(3) } },
    ]);
    const listed = (
      await x
        .http('get', '/staff/security/inspection-requests', supervisor.token)
        .expect(200)
    ).body as (RequestBody & { unitCode: string })[];
    expect(listed.map((r) => r.id)).toContain(asked.id);

    // A custom task never answers a request; another unit's never either.
    const guard = await x.guard(s.c);
    expect(
      (
        await x.http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'custom',
          title: 'Look',
          guardId: guard.id,
          requestId: asked.id,
        })
      ).status,
    ).toBe(400);
    const task = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'closed_unit_inspection',
          unitId: s.home.id,
          guardId: guard.id,
          requestId: asked.id,
        })
        .expect(201)
    ).body as { id: string };
    expect((await row(s, asked.id)).status).toBe('scheduled');
    // A scheduled request is cancelled with its task, not here.
    expect(
      codeOf(
        await x.http(
          'post',
          `/units/${s.home.id}/inspection-requests/${asked.id}/cancel`,
          s.alice.token,
          { reasonCode: 'not_needed' },
        ),
      ),
    ).toBe('INSPECTION_REQUEST_CLOSED');

    const gateId = (await x.g.gate(s.c)).id;
    await x.start(guard, { gateId });
    await x
      .http('post', `/gate/tasks/${task.id}/take`, guard.token)
      .expect(200);
    const photo = await x.files.ready(guard.token, 'guard_task_photo');
    await x
      .http('post', `/gate/tasks/${task.id}/complete`, guard.token, {
        outcome: 'all_clear',
        note: 'Windows shut, no leak',
        photoFileIds: [photo],
      })
      .expect(200);
    expect((await row(s, asked.id)).status).toBe('done');

    const reports = await x
      .http('get', `/units/${s.home.id}/inspections`, s.alice.token)
      .expect(200);
    expect(reports.headers['cache-control']).toBe('no-store');
    const [report] = reports.body as ReportBody[];
    expect(report).toMatchObject({
      taskId: task.id,
      requestId: asked.id,
      outcome: 'all_clear',
      note: 'Windows shut, no leak',
    });
    expect(report.photos).toHaveLength(1);
    // Never who inspected.
    expect(JSON.stringify(reports.body)).not.toContain(guard.id);
  });

  it('only the unit’s owners ask; an open request is cancelled by either side with a code; a cancelled task cancels its request', async () => {
    const s = await x.setUp('Inspection Rules Court');
    const supervisor = await x.supervisor(s.c);
    await close(s);
    const tenant = await x.v.who(
      s.c,
      (await x.v.x.resident(s.c, [s.home.id], 'tenant')).id,
      'resident',
    );
    expect(codeOf(await ask(s, tenant))).toBe('INSPECTION_NOT_ALLOWED');

    const first = (await ask(s).expect(201)).body as RequestBody;
    const mine = await x
      .http(
        'post',
        `/units/${s.home.id}/inspection-requests/${first.id}/cancel`,
        s.alice.token,
        { reasonCode: 'not_needed' },
      )
      .expect(200);
    expect(mine.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'not_needed',
    });

    const second = (await ask(s).expect(201)).body as RequestBody;
    const guard = await x.guard(s.c);
    const task = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'closed_unit_inspection',
          unitId: s.home.id,
          guardId: guard.id,
          requestId: second.id,
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http(
        'post',
        `/staff/security/tasks/${task.id}/cancel`,
        supervisor.token,
        {
          reasonCode: 'unit_reopened',
        },
      )
      .expect(200);
    expect(await row(s, second.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'task_cancelled',
    });
  });

  it('a request moves forward only', async () => {
    const s = await x.setUp('Inspection Schema Court');
    await close(s);
    const asked = (await ask(s).expect(201)).body as RequestBody;
    await expect(
      x.inTx(s.c, (tx) =>
        tx.unitInspectionRequest.update({
          where: { id: asked.id },
          data: { preferredOn: new Date('2099-01-01T00:00:00Z') },
        }),
      ),
    ).rejects.toThrow(/unit_inspection_requests/);
    await expect(
      x.inTx(s.c, (tx) =>
        tx.unitInspectionRequest.delete({ where: { id: asked.id } }),
      ),
    ).rejects.toThrow(/unit_inspection_requests/);
  });

  it('race: two requests at once — one is open', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await x.setUp(`Inspection Race Court ${i}`);
      await close(s);
      const both = await Promise.all([ask(s), ask(s)]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(both.map(codeOf).filter(Boolean)).toEqual([
        'INSPECTION_REQUEST_OPEN',
      ]);
    }
  });

  it('race: a cancel against the scheduling — never a task on a cancelled request', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await x.setUp(`Inspection Schedule Race ${i}`);
      const supervisor = await x.supervisor(s.c);
      await close(s);
      const asked = (await ask(s).expect(201)).body as RequestBody;
      const guard = await x.guard(s.c);
      const [cancelled, scheduled] = await Promise.all([
        x.http(
          'post',
          `/units/${s.home.id}/inspection-requests/${asked.id}/cancel`,
          s.alice.token,
          { reasonCode: 'not_needed' },
        ),
        x.http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'closed_unit_inspection',
          unitId: s.home.id,
          guardId: guard.id,
          requestId: asked.id,
        }),
      ]);
      expect(
        [cancelled.status === 200, scheduled.status === 201].filter(Boolean),
      ).toHaveLength(1);
      const tasks = await x.inTx(s.c, (tx) =>
        tx.guardTask.count({ where: { requestId: asked.id } }),
      );
      expect(tasks).toBe(scheduled.status === 201 ? 1 : 0);
    }
  });
});
