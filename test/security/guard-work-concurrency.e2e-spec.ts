import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

/**
 * ADR 0050, the guards' work decided one at a time: a handover is
 * acknowledged once whoever asks together; an end racing a new checklist
 * item either saw it (and asks for it) or did not (and records without it).
 */
describe('Guard work under concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Guard Work Race Court');
  }, 120_000);

  afterAll(() => h.close());

  /** Ends a guard's shift ticking the whole checklist (a race adds items). */
  const end = async (g: Who) => {
    const items = (
      (await x.http('get', '/gate/handover-items', g.token).expect(200))
        .body as { data: { id: string }[] }
    ).data.map((it) => it.id);
    return x.endRaw(g, { checklist: items });
  };

  it('two guards acknowledging one handover: one wins', async () => {
    for (let i = 0; i < 5; i++) {
      const gateId = (await x.g.gate(s.c)).id;
      const author = await x.guard(s.c);
      await x.start(author, { gateId });
      await x.endRaw(author).expect(200);
      const a = await x.guard(s.c);
      const b = await x.guard(s.c);
      await x.start(a, { gateId });
      await x.start(b, { gateId });
      const handover = await x.inTx(s.c, (tx) =>
        tx.guardHandover.findFirstOrThrow({
          where: { guardAccountId: author.id },
        }),
      );
      const path = `/gate/handovers/${handover.id}/acknowledge`;
      const results = await Promise.all([
        x.http('post', path, a.token),
        x.http('post', path, b.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'HANDOVER_ALREADY_ACKNOWLEDGED',
      });
    }
  });

  it('an end racing a new checklist item: refused for it, or recorded without it', async () => {
    const supervisor = await x.supervisor(s.c);
    for (let i = 0; i < 5; i++) {
      const guard = await x.guard(s.c);
      const shift = await x.start(guard, { gateId: (await x.g.gate(s.c)).id });
      const active = (
        (await x.http('get', '/gate/handover-items', guard.token).expect(200))
          .body as { data: { id: string }[] }
      ).data.map((it) => it.id);
      const [ended, added] = await Promise.all([
        x.endRaw(guard, { checklist: active }),
        x.http('post', '/staff/security/handover-items', supervisor.token, {
          label: `Race item ${i}`,
        }),
      ]);
      expect(added.status).toBe(201);
      const newId = (added.body as { id: string }).id;
      if (ended.status === 200) {
        const recorded = await x.inTx(s.c, (tx) =>
          tx.guardHandover.findFirstOrThrow({ where: { shiftId: shift.id } }),
        );
        expect(
          (recorded.checklist as { itemId: string }[]).map((c) => c.itemId),
        ).not.toContain(newId);
      } else {
        expect(ended.status).toBe(422);
        expect(ended.body).toMatchObject({
          code: 'HANDOVER_CHECKLIST_INCOMPLETE',
          params: { missing: [newId] },
        });
        expect((await x.shiftRow(s.c, shift.id)).endedAt).toBeNull();
        await x.endRaw(guard, { checklist: [...active, newId] }).expect(200);
      }
    }
  });

  it('two guards taking one task: one wins', async () => {
    const supervisor = await x.supervisor(s.c);
    for (let i = 0; i < 5; i++) {
      const gateId = (await x.g.gate(s.c)).id;
      const a = await x.guard(s.c);
      const b = await x.guard(s.c);
      await x.start(a, { gateId });
      await x.start(b, { gateId });
      const task = (
        await x
          .http('post', '/staff/security/tasks', supervisor.token, {
            kind: 'custom',
            title: `Race ${i}`,
            gateId,
          })
          .expect(201)
      ).body as { id: string };
      const path = `/gate/tasks/${task.id}/take`;
      const results = await Promise.all([
        x.http('post', path, a.token),
        x.http('post', path, b.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await end(a)).status).toBe(200);
      expect((await end(b)).status).toBe(200);
    }
  });

  it('a shift ending while another guard takes its guard’s task: never held by the one who left', async () => {
    const supervisor = await x.supervisor(s.c);
    for (let i = 0; i < 5; i++) {
      const gateId = (await x.g.gate(s.c)).id;
      const leaving = await x.guard(s.c);
      const other = await x.guard(s.c);
      await x.start(leaving, { gateId });
      await x.start(other, { gateId });
      const task = (
        await x
          .http('post', '/staff/security/tasks', supervisor.token, {
            kind: 'custom',
            title: `Carry race ${i}`,
            gateId,
          })
          .expect(201)
      ).body as { id: string };
      await x
        .http('post', `/gate/tasks/${task.id}/take`, leaving.token)
        .expect(200);
      const [ended, taken] = await Promise.all([
        end(leaving),
        x.http('post', `/gate/tasks/${task.id}/take`, other.token),
      ]);
      expect(ended.status).toBe(200);
      expect([200, 409]).toContain(taken.status);
      const row = await x.inTx(s.c, (tx) =>
        tx.guardTask.findUniqueOrThrow({ where: { id: task.id } }),
      );
      expect(row.takenById).not.toBe(leaving.id);
      expect(row).toMatchObject(
        taken.status === 200
          ? { status: 'in_progress', takenById: other.id }
          : { status: 'open', takenById: null },
      );
      expect((await end(other)).status).toBe(200);
    }
  });
});
