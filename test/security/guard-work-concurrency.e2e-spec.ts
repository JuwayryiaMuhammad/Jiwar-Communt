import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers } from '../setup/security';

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
});
