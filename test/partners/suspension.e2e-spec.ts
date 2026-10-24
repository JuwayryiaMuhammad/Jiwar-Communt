import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { ALWAYS, partnersHelpers, type PartnersSetUp } from '../setup/partners';

interface DetailBody {
  id: string;
  status: string;
  alternatives: { id: string; openNow: boolean }[];
  [key: string]: unknown;
}

/**
 * A partner's suspension (ADR 0060): new requests and its desk stop, its
 * live requests are cancelled with their passes, those who asked it or
 * keep it as a favourite are told once, and its page offers alternatives
 * in the same categories — never why.
 */
describe('Partners: suspension (ADR 0060)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    await p.consent(s.alice);
    await p.consent(s.bob);
  }, 180_000);

  afterAll(() => h.close());

  const suspend = (id: string, reasonCode = 'safety') =>
    p.http('post', `/staff/partners/${id}/suspend`, s.keeper.token, {
      reasonCode,
    });
  const err = (res: { body: unknown }) => res.body as { code: string };

  it('cancels the live requests with their passes; tells the requesters and the favourites once each', async () => {
    const id = await p.partner(s.c, s.keeper);
    const token = await p.deskLink(s.keeper, id);
    const pending = await p.request(s.alice, s.homeA.id, id);
    const accepted = await p.request(s.bob, s.homeB.id, id);
    await p.desk(token, `/requests/${accepted.id}/accept`).expect(200);
    const passId = (await p.row(s.c, accepted.id)).passId!;
    // Alice both asked and keeps it as a favourite: told once.
    await p.http('put', `/partners/${id}/favourite`, s.alice.token).expect(204);
    const carol = await p.owner(s.c, s.homeA.id);
    await p.http('put', `/partners/${id}/favourite`, carol.token).expect(204);

    const res = await suspend(id).expect(200);
    expect(res.body).toMatchObject({
      status: 'suspended',
      suspendedReason: 'safety',
    });
    for (const r of [pending, accepted])
      expect(await p.row(s.c, r.id)).toMatchObject({
        status: 'cancelled',
        closedBy: 'system',
        closeReason: 'partner_suspended',
      });
    const pass = await p.inTx(s.c, (tx) =>
      tx.visitorPass.findUniqueOrThrow({ where: { id: passId } }),
    );
    expect(pass.status).toBe('cancelled');
    for (const who of [s.alice, s.bob, carol]) {
      const told = (
        await p.notifications(s.c, who.id, 'partner.suspended')
      ).filter((n) => n.targetId === id);
      expect(told).toHaveLength(1);
      expect(told[0].params).toEqual({});
    }
    // Nobody is told of the cancel itself: the suspension says it.
    expect(
      (
        await p.notifications(s.c, s.alice.id, 'partner_request.cancelled')
      ).some((n) => n.targetId === pending.id),
    ).toBe(false);
    // Its desk is closed.
    const desk = await p.desk(token, '/lookup');
    expect([desk.status, err(desk).code]).toEqual([
      404,
      'PARTNER_DESK_NOT_FOUND',
    ]);
  });

  it('takes no request; is listed to nobody; its page says it is suspended, never why, and offers alternatives', async () => {
    const pest = await p.subcategory(s.c, 'pest_control');
    const gone = await p.partner(s.c, s.keeper, {
      services: [{ category: 'home_services', subcategoryId: pest }],
    });
    const open = await p.partner(s.c, s.keeper, {}, ALWAYS);
    const closed = await p.partner(s.c, s.keeper, {}, p.closedTodayHours());
    const otherCategory = await p.partner(s.c, s.keeper, {
      services: [{ category: 'pets' }],
    });
    await suspend(gone, 'quality_complaints').expect(200);

    const asked = await p.ask(s.alice, s.homeA.id, gone, {
      subcategoryId: pest,
    });
    expect([asked.status, err(asked).code]).toEqual([409, 'PARTNER_SUSPENDED']);
    expect((await p.listed(s.alice)).map((x) => x.id)).not.toContain(gone);

    const page = (await p.get(s.alice, gone).expect(200)).body as DetailBody;
    expect(page.status).toBe('suspended');
    expect(page).not.toHaveProperty('suspendedReason');
    expect(JSON.stringify(page)).not.toContain('quality_complaints');
    const offered = page.alternatives.map((a) => a.id);
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(offered).not.toContain(gone);
    expect(offered).not.toContain(otherCategory);
    expect(offered).toContain(open);
    // Open now first.
    if (offered.includes(closed))
      expect(offered.indexOf(open)).toBeLessThan(offered.indexOf(closed));
  });

  it('a suspension and a new request at once: refused, or made and then cancelled — never live on a suspended partner', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await p.partner(s.c, s.keeper);
      const [made, suspended] = await Promise.all([
        p.ask(s.alice, s.homeA.id, id),
        suspend(id),
      ]);
      expect(suspended.status).toBe(200);
      if (made.status === 201) {
        const row = await p.row(s.c, (made.body as { id: string }).id);
        expect(row).toMatchObject({
          status: 'cancelled',
          closeReason: 'partner_suspended',
        });
      } else expect(err(made).code).toBe('PARTNER_SUSPENDED');
      const live = await p.inTx(s.c, (tx) =>
        tx.partnerRequest.count({
          where: {
            partnerId: id,
            status: { in: ['pending', 'proposed', 'accepted'] },
          },
        }),
      );
      expect(live).toBe(0);
    }
  });

  it('suspended once; reinstated, it takes requests again and tells nobody; its desk link works again', async () => {
    const id = await p.partner(s.c, s.keeper);
    const token = await p.deskLink(s.keeper, id);
    await suspend(id).expect(200);
    expect(err(await suspend(id)).code).toBe('PARTNER_ALREADY_SUSPENDED');
    await p
      .http('post', `/staff/partners/${id}/reinstate`, s.keeper.token)
      .expect(200);
    expect(
      err(
        await p.http('post', `/staff/partners/${id}/reinstate`, s.keeper.token),
      ).code,
    ).toBe('PARTNER_NOT_SUSPENDED');
    expect((await p.ask(s.alice, s.homeA.id, id)).status).toBe(201);
    await p.desk(token, '/lookup').expect(200);
  });
});
