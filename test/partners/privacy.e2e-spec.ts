import { AccountsService } from '../../src/core/accounts/accounts.service';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  partnersHelpers,
  shiftWindow,
  type PartnersSetUp,
  type Who,
} from '../setup/partners';

/**
 * ADR 0060 with ADR 0023 and 0036: what a personal-data export holds of a
 * resident's partner requests, and what becomes of them and their words
 * when they are erased, deactivated or leave the unit.
 */
describe('Partners — export, erasure, deactivation and leaving', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;
  let partnerId: string;
  let token: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    partnerId = await p.partner(s.c, s.keeper);
    token = await p.deskLink(s.keeper, partnerId);
  }, 180_000);

  afterAll(() => h.close());

  /** A second owner who lives in the unit: not its primary, so they can go. */
  async function resident(unitId: string) {
    const created = await p.x.resident(s.c, [unitId]);
    const who = { ...created, ...(await p.who(s.c, created.id, 'resident')) };
    await p.consent(who);
    return who;
  }

  async function exportOf(who: Who & { email: string }) {
    await stepUp(h, who.token, who.email);
    const asked = await h
      .http()
      .post(`${API}/me/data-exports`)
      .set('Authorization', `Bearer ${who.token}`)
      .send({})
      .expect(201);
    await buildExports(h);
    const dl = await h
      .http()
      .get(
        `${API}/me/data-exports/${(asked.body as { id: string }).id}/download`,
      )
      .set('Authorization', `Bearer ${who.token}`)
      .expect(200);
    return readArchive((dl.body as { url: string }).url);
  }

  /** A request done and rated, with a comment. */
  async function rated(who: Who, unitId: string) {
    const id = (await p.request(who, unitId, partnerId, { note: 'NOTE-WORDS' }))
      .id;
    await p.desk(token, `/requests/${id}/accept`).expect(200);
    await shiftWindow(id, 'started');
    await p.http('post', `/partner-requests/${id}/done`, who.token).expect(200);
    await p
      .http('post', `/partner-requests/${id}/rating`, who.token, {
        stars: 4,
        comment: 'COMMENT-WORDS',
      })
      .expect(200);
    return id;
  }

  it('the export holds the account’s own requests, with their history and rating, and its favourites — nothing of anyone else', async () => {
    const who = await resident(s.homeA.id);
    const done = await rated(who, s.homeA.id);
    await p
      .http('put', `/partners/${partnerId}/favourite`, who.token)
      .expect(204);
    const archive = await exportOf(who);
    const requests = JSON.parse(archive.text('partners/requests.json')) as {
      id: string;
      note: string;
      rating: { stars: number } | null;
      history: { kind: string }[];
    }[];
    expect(requests.find((r) => r.id === done)).toMatchObject({
      note: 'NOTE-WORDS',
      rating: { stars: 4 },
    });
    const favourites = JSON.parse(archive.text('partners/favourites.json')) as {
      partnerId: string;
    }[];
    expect(favourites.map((f) => f.partnerId)).toEqual([partnerId]);
    const text = archive.text('partners/requests.json');
    expect(text).not.toContain(s.alice.id);
    expect(text).not.toContain('desk');
  });

  it('erased: live requests cancelled by the system (`requester_left`), notes and comments gone once, favourites deleted; the rows stay', async () => {
    const who = await resident(s.homeA.id);
    const live = (await p.request(who, s.homeA.id, partnerId, { note: 'GONE' }))
      .id;
    await p.desk(token, `/requests/${live}/accept`).expect(200);
    const passId = (await p.row(s.c, live)).passId!;
    const done = await rated(who, s.homeA.id);
    await p
      .http('put', `/partners/${partnerId}/favourite`, who.token)
      .expect(204);
    await eraseNow(h, s.c, who.id);
    expect(await p.row(s.c, live)).toMatchObject({
      status: 'cancelled',
      closedBy: 'system',
      closeReason: 'requester_left',
      note: null,
      requesterId: who.id,
    });
    expect((await p.row(s.c, done)).note).toBeNull();
    const rating = await p.inTx(s.c, (tx) =>
      tx.partnerRating.findFirstOrThrow({ where: { requestId: done } }),
    );
    expect(rating).toMatchObject({ stars: 4, comment: null });
    expect(rating.commentClearedAt).not.toBeNull();
    expect(
      await p.inTx(s.c, (tx) =>
        tx.partnerFavourite.count({ where: { accountId: who.id } }),
      ),
    ).toBe(0);
    const pass = await p.inTx(s.c, (tx) =>
      tx.visitorPass.findUniqueOrThrow({ where: { id: passId } }),
    );
    expect(pass.status).toBe('cancelled');
    // The desk shows nothing of them.
    const desk = (
      (await p.desk(token, '/lookup').expect(200)).body as {
        requests: {
          id: string;
          firstName: string | null;
          note: string | null;
        }[];
      }
    ).requests.find((r) => r.id === live);
    if (desk) expect(desk).toMatchObject({ firstName: null, note: null });
  });

  it('deactivated: the same, `requester_left`', async () => {
    const who = await resident(s.homeA.id);
    const live = (await p.request(who, s.homeA.id, partnerId)).id;
    await p.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(who.id, { status: 'inactive' }),
    );
    expect(await p.row(s.c, live)).toMatchObject({
      status: 'cancelled',
      closeReason: 'requester_left',
    });
  });

  it('leaving a unit: its live requests there are cancelled; another unit’s stay', async () => {
    const created = await p.x.resident(s.c, [s.homeA.id, s.homeB.id]);
    const who = await p.who(s.c, created.id, 'resident');
    await p.consent(who);
    const here = (await p.request(who, s.homeA.id, partnerId)).id;
    const there = (await p.request(who, s.homeB.id, partnerId)).id;
    const occupancies = await p.x.occupancies(s.c, s.homeA.id);
    const mine = occupancies.find(
      (o) => o.accountId === who.id && o.status === 'active',
    )!;
    await p.x.asManager(s.c, () =>
      p.x.residents.endOccupancy(mine.id, {
        code: 'moved_out',
        text: 'Moved out',
      }),
    );
    expect(await p.row(s.c, here)).toMatchObject({
      status: 'cancelled',
      closeReason: 'requester_left',
    });
    expect((await p.row(s.c, there)).status).toBe('pending');
  });
});
