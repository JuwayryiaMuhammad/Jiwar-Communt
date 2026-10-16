import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

const DAY = 24 * 60;

/**
 * ADR 0050, swaps under concurrency: a decision is made once; an approval
 * and a withdrawal, two requests on one slot, an approval and the slot's
 * opening are each decided one way, whole.
 */
describe('Shift swaps under concurrency', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let one: Who;
  let two: Who;
  let gateId: string;
  let day = 0;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Swap Race Court');
    one = await x.supervisor(s.c);
    two = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  /** A fresh accepted swap: a's slot (in `inMinutes`) to b, as a cover. */
  async function accepted(inMinutes = ++day * DAY) {
    const a = await x.guard(s.c);
    const b = await x.guard(s.c);
    const slot = await x.slot(one, a.id, { gateId }, inMinutes, 60);
    const swap = (
      await x
        .http('post', '/gate/swaps', a.token, {
          slotId: slot.id,
          colleagueId: b.id,
        })
        .expect(201)
    ).body as { id: string };
    await x.http('post', `/gate/swaps/${swap.id}/accept`, b.token).expect(200);
    return { a, b, slot, swap };
  }

  it('two keepers approving at once: one wins', async () => {
    for (let i = 0; i < 5; i++) {
      const { swap } = await accepted();
      const path = `/staff/security/swaps/${swap.id}/approve`;
      const results = await Promise.all([
        x.http('post', path, one.token),
        x.http('post', path, two.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    }
  });

  it('an approval racing a withdrawal: one or the other, whole', async () => {
    for (let i = 0; i < 5; i++) {
      const { a, b, slot, swap } = await accepted();
      const [approved, withdrawn] = await Promise.all([
        x.http('post', `/staff/security/swaps/${swap.id}/approve`, one.token),
        x.http('post', `/gate/swaps/${swap.id}/withdraw`, a.token),
      ]);
      expect([approved.status, withdrawn.status].sort()).toEqual([200, 409]);
      const row = await x.slotRow(s.c, slot.id);
      expect(row.guardAccountId).toBe(approved.status === 200 ? b.id : a.id);
    }
  });

  it('two requests for one slot: one is made', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await x.guard(s.c);
      const b = await x.guard(s.c);
      const c = await x.guard(s.c);
      const slot = await x.slot(one, a.id, { gateId }, ++day * DAY, 60);
      const results = await Promise.all(
        [b, c].map((colleague) =>
          x.http('post', '/gate/swaps', a.token, {
            slotId: slot.id,
            colleagueId: colleague.id,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'SWAP_SLOT_BUSY',
      });
    }
  });

  it('an approval racing the slot’s opening: given away unopened, or opened and kept', async () => {
    for (let i = 0; i < 5; i++) {
      // Within the 30 minutes before its start, the slot may be filled.
      const { a, b, slot, swap } = await accepted(20);
      const [approved, started] = await Promise.all([
        x.http('post', `/staff/security/swaps/${swap.id}/approve`, one.token),
        x.startRaw(a, { gateId }),
      ]);
      expect(started.status).toBe(201);
      const row = await x.slotRow(s.c, slot.id);
      if (approved.status === 200) {
        expect(row).toMatchObject({ guardAccountId: b.id, shiftId: null });
      } else {
        expect(approved.body).toMatchObject({
          code: 'SWAP_NOT_POSSIBLE',
          params: { reason: 'slot_changed' },
        });
        expect(row).toMatchObject({ guardAccountId: a.id });
        expect(row.shiftId).not.toBeNull();
      }
      await x.endRaw(a).expect(200);
    }
  });
});
