import { addDays } from '../../src/maintenance/schedules/local-dates';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** An answer's body, as the assertions read it. */
type Body = {
  code: string;
  fields: { field: string; code: string }[];
  [key: string]: unknown;
};

interface Claim {
  id: string;
  status: string;
  reference: string | null;
  reasonCode: string | null;
  recoveredAmount: string | null;
}

/**
 * ADR 0076: an asset's warranty whole (its start, its warrantor, what it
 * covers, beside its end) and the claims made under it: while it runs,
 * at most one open claim per ticket of the asset's, the warrantor's
 * reference added while open, decided once under the claim's lock. Words
 * never reach the audit trail.
 */
describe('Dispatch depth — warranties and their claims', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let plumbing: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    plumbing = await a.categoryId(s.c, 'plumbing');
  }, 180_000);

  afterAll(() => h.close());

  const patch = (id: string, body: object) =>
    a.http('patch', `/maintenance/assets/${id}`, s.manager.token, body);

  /** An asset whose warranty runs from 30 days ago to 30 days ahead. */
  async function covered(): Promise<string> {
    const id = await a.asset(s);
    await patch(id, {
      warrantyStartsOn: addDays(today(), -30),
      warrantyEndsOn: addDays(today(), 30),
      warrantor: 'Pumps & Co',
      warrantyCovers: 'Motor and seals',
    }).expect(200);
    return id;
  }

  const ticketOn = async (assetId: string) =>
    (
      (
        await a
          .http('post', '/maintenance/work-orders', s.supervisor.token, {
            assetId,
            categoryId: plumbing,
            description: 'Seal failed',
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  const claim = (body: object, token = s.manager.token) =>
    a.http('post', '/maintenance/warranty-claims', token, {
      description: 'The seal failed within the warranty',
      ...body,
    });

  const act = (id: string, verb: string, body: object = {}) =>
    a.http(
      'post',
      `/maintenance/warranty-claims/${id}/${verb}`,
      s.manager.token,
      body,
    );

  it('the warranty’s start, warrantor and cover on the card; the texts sensitive in the audit', async () => {
    const id = await covered();
    const card = await a
      .http('get', `/maintenance/assets/${id}`, s.manager.token)
      .expect(200);
    expect(card.body).toMatchObject({
      warrantyStartsOn: addDays(today(), -30),
      warrantyEndsOn: addDays(today(), 30),
      warrantor: 'Pumps & Co',
      warrantyCovers: 'Motor and seals',
      underWarranty: true,
    });
    const audit = await a.inTenant(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'asset.updated', targetId: id },
      }),
    );
    expect(JSON.stringify(audit)).not.toContain('Pumps');
    expect(JSON.stringify(audit)).not.toContain('seals');
  });

  it('a warranty that starts after it ends is refused', async () => {
    const id = await a.asset(s);
    const res = await patch(id, {
      warrantyStartsOn: addDays(today(), 10),
      warrantyEndsOn: addDays(today(), 5),
    }).expect(400);
    expect((res.body as Body).fields).toEqual([
      { field: 'warrantyEndsOn', code: 'ENDS_BEFORE_START' },
    ]);
  });

  it('a claim while it runs, on one of the asset’s tickets; one open per ticket', async () => {
    const assetId = await covered();
    const ticketId = await ticketOn(assetId);
    const first = (await claim({ assetId, ticketId }).expect(201))
      .body as Claim;
    expect(first).toMatchObject({ status: 'open', reference: null });
    const again = await claim({ assetId, ticketId }).expect(409);
    expect((again.body as Body).code).toBe('WARRANTY_CLAIM_OPEN');
    const other = await covered();
    const wrong = await claim({ assetId: other, ticketId }).expect(409);
    expect((wrong.body as Body).code).toBe('TICKET_NOT_OF_ASSET');
    const audit = await a.inTenant(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'warranty_claim.opened', targetId: first.id },
      }),
    );
    expect(audit.metadata).toEqual({ assetId, ticketId });
    expect(JSON.stringify(audit)).not.toContain('seal failed');
  });

  it('no claim without a warranty running, nor after it ended', async () => {
    const bare = await a.asset(s);
    expect(
      ((await claim({ assetId: bare }).expect(409)).body as Body).code,
    ).toBe('ASSET_NO_WARRANTY');
    const ended = await a.asset(s);
    await patch(ended, { warrantyEndsOn: addDays(today(), -1) }).expect(200);
    const res = await claim({ assetId: ended }).expect(409);
    expect(res.body).toMatchObject({
      code: 'WARRANTY_EXPIRED',
      params: { endsOn: addDays(today(), -1) },
    });
  });

  it('the warrantor’s reference while open; accepted once with what it recovered', async () => {
    const assetId = await covered();
    const c = (await claim({ assetId }).expect(201)).body as Claim;
    await a
      .http('patch', `/maintenance/warranty-claims/${c.id}`, s.manager.token, {
        reference: 'WR-7781',
      })
      .expect(200)
      .expect((r) => expect((r.body as Body).reference).toBe('WR-7781'));
    const accepted = (
      await act(c.id, 'accept', { recoveredAmount: '1500' }).expect(201)
    ).body as Claim;
    expect(accepted).toMatchObject({
      status: 'accepted',
      recoveredAmount: '1500.00',
      reasonCode: null,
    });
    const late = await act(c.id, 'withdraw', {
      reasonCode: 'raised_in_error',
    }).expect(409);
    expect(late.body).toMatchObject({
      code: 'WARRANTY_CLAIM_DECIDED',
      params: { status: 'accepted' },
    });
    await a
      .http('patch', `/maintenance/warranty-claims/${c.id}`, s.manager.token, {
        reference: 'WR-1',
      })
      .expect(409);
  });

  it('rejected or withdrawn with a code from its list', async () => {
    const assetId = await covered();
    const c = (await claim({ assetId }).expect(201)).body as Claim;
    expect(((await act(c.id, 'reject').expect(400)).body as Body).code).toBe(
      'REASON_REQUIRED',
    );
    const rejected = (
      await act(c.id, 'reject', { reasonCode: 'misuse' }).expect(201)
    ).body as Claim;
    expect(rejected).toMatchObject({
      status: 'rejected',
      reasonCode: 'misuse',
    });
    const list = await a
      .http(
        'get',
        `/maintenance/warranty-claims?assetId=${assetId}&status=rejected`,
        s.manager.token,
      )
      .expect(200);
    expect((list.body as { data: Claim[] }).data.map((x) => x.id)).toEqual([
      c.id,
    ]);
  });

  it('is the asset keepers’: a resident may not', async () => {
    await claim({ assetId: await covered() }, s.owner.token).expect(403);
  });

  it('race: accepted and withdrawn at once, decided once', async () => {
    for (let i = 0; i < 3; i++) {
      const c = (await claim({ assetId: await covered() }).expect(201))
        .body as Claim;
      const results = await Promise.all([
        act(c.id, 'accept'),
        act(c.id, 'withdraw', { reasonCode: 'repaired_otherwise' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    }
  });

  it('race: two claims on one ticket at once, one opened', async () => {
    const assetId = await covered();
    const ticketId = await ticketOn(assetId);
    const results = await Promise.all([
      claim({ assetId, ticketId }),
      claim({ assetId, ticketId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});
