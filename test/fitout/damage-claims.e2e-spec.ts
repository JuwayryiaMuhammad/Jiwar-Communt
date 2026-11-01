import { ResidentsService } from '../../src/community/residents/residents.service';
import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { financeHelpers } from '../setup/finance';
import { damageClaimRow } from '../setup/fitout-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred, permitHelpers, type PermitSetUp } from '../setup/permits';

interface ClaimBody {
  id: string;
  number: string;
  reasonCode: string;
  amount: string;
  status: string;
  appeal: { text: string | null; decision: string | null } | null;
  withdrawn: { reason: string } | null;
  settlement: {
    deducted: string;
    charged: string;
    invoiceId: string | null;
    chargeStatus: string | null;
  } | null;
}
interface FitOutBody {
  deposit: { held: string } | null;
  claims: ClaimBody[];
}

/**
 * Damage claims on a works permit (ADR 0074): raised by the management,
 * appealed once by the household within 14 days, upheld or accepted,
 * withdrawn, or settled once — from the works deposit as far as it holds,
 * the rest as a `damage` invoice of the unit's.
 */
describe('Fit-out — damage claims', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let f: ReturnType<typeof financeHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    f = financeHelpers(h);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const staff = (permitId: string) => `/staff/unit-permits/${permitId}`;
  const fitOut = (res: { body: unknown }) => res.body as FitOutBody;
  const claimOf = (res: { body: unknown }, id: string) =>
    fitOut(res).claims.find((c) => c.id === id)!;

  /** An approved works permit of alice's home, its deposit 5000 held. */
  async function approved(s: PermitSetUp) {
    const permit = await p.works(s.alice, s.home.id);
    await p.approve(s.manager, permit.id);
    return permit;
  }
  function raise(
    s: PermitSetUp,
    permitId: string,
    over: Record<string, unknown> = {},
  ) {
    return deferred(
      (async () =>
        p.http('post', `${staff(permitId)}/damage-claims`, s.manager.token, {
          reasonCode: 'common_area_damage',
          description: 'The lobby wall was chipped by the workers.',
          amount: '1500',
          photoFileIds: [await p.files.ready(s.manager.token, 'fitout_photo')],
          ...over,
        }))(),
    );
  }
  const appeal = (s: PermitSetUp, permitId: string, claimId: string) =>
    p.http(
      'post',
      `/permits/${permitId}/damage-claims/${claimId}/appeal`,
      s.alice.token,
      { text: 'The wall was chipped before our works began.' },
    );
  const decide = (
    s: PermitSetUp,
    permitId: string,
    claimId: string,
    decision: 'upheld' | 'accepted',
  ) =>
    p.http(
      'post',
      `${staff(permitId)}/damage-claims/${claimId}/appeal-decision`,
      s.manager.token,
      { decision },
    );
  const settle = (s: PermitSetUp, permitId: string, claimId: string) =>
    deferred(
      (async () => {
        await f.stepUp(s.manager.token);
        return p.http(
          'post',
          `${staff(permitId)}/damage-claims/${claimId}/settle`,
          s.manager.token,
        );
      })(),
    );
  /** A claim whose 14 days passed, as a row: its id. */
  const lapsed = (s: PermitSetUp, permitId: string, amount: string) =>
    p.v.inTx(s.c, (tx) =>
      damageClaimRow(tx, {
        tenantId: s.c.tenantId,
        permitId,
        unitId: s.home.id,
        raisedBy: s.manager.id,
        amount,
        raisedAt: new Date(dbClock().getTime() - 2 * 3_600_000),
        appealUntil: new Date(dbClock().getTime() - 3_600_000),
      }),
    );

  it('raised, appealed, upheld, then settled from the deposit with a step-up: the household told at each step', async () => {
    const s = await p.setUp('Claims Court');
    const permit = await approved(s);
    const raised = await raise(s, permit.id).expect(201);
    expect(raised.headers['cache-control']).toBe('no-store');
    const [claim] = fitOut(raised).claims;
    expect(claim).toMatchObject({
      number: expect.stringMatching(/^DC-\d{4}$/) as string,
      reasonCode: 'common_area_damage',
      amount: '1500.00',
      status: 'open',
      appeal: null,
    });
    expect(await p.told(s.c, s.alice.id, permit.id)).toContainEqual({
      kind: 'unit_permit.damage_claimed',
      params: { claimNumber: claim.number },
    });
    // Without a fresh step-up: refused.
    expect(
      (
        await p
          .http(
            'post',
            `${staff(permit.id)}/damage-claims/${claim.id}/settle`,
            s.manager.token,
          )
          .expect(403)
      ).body,
    ).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // Within the window, nothing settles it.
    expect(
      (await settle(s, permit.id, claim.id).expect(409)).body,
    ).toMatchObject({ code: 'DAMAGE_CLAIM_APPEAL_WINDOW' });
    const appealed = await appeal(s, permit.id, claim.id).expect(200);
    expect(claimOf(appealed, claim.id)).toMatchObject({
      status: 'under_appeal',
      appeal: { text: 'The wall was chipped before our works began.' },
    });
    expect(
      (await appeal(s, permit.id, claim.id).expect(409)).body,
    ).toMatchObject({ code: 'DAMAGE_CLAIM_NO_APPEAL' });
    expect(await p.told(s.c, s.manager.id, permit.id)).toContainEqual({
      kind: 'unit_permit.damage_appealed',
      params: { claimNumber: claim.number },
    });
    expect(
      claimOf(
        await decide(s, permit.id, claim.id, 'upheld').expect(200),
        claim.id,
      ),
    ).toMatchObject({ status: 'open', appeal: { decision: 'upheld' } });
    const settled = await settle(s, permit.id, claim.id).expect(200);
    expect(claimOf(settled, claim.id)).toMatchObject({
      status: 'settled',
      settlement: {
        deducted: '1500.00',
        charged: '0.00',
        invoiceId: null,
        chargeStatus: null,
      },
    });
    expect(fitOut(settled).deposit?.held).toBe('3500.00');
    expect(await p.told(s.c, s.alice.id, permit.id)).toEqual(
      expect.arrayContaining([
        {
          kind: 'unit_permit.damage_appeal_decided',
          params: { claimNumber: claim.number, decision: 'upheld' },
        },
        {
          kind: 'unit_permit.damage_settled',
          params: { claimNumber: claim.number },
        },
      ]),
    );
    const audit = await read.tenant(s.c.tenantId, {
      action: 'damage_claim.settled',
      targetId: claim.id,
    });
    expect(audit.map((r) => r.metadata)).toEqual([
      {
        permitId: permit.id,
        deducted: '1500.00',
        charged: '0.00',
        invoiceId: null,
      },
    ]);
  });

  it('more than the deposit holds: the rest owed as a damage invoice of the unit’s', async () => {
    const s = await p.setUp('Claims Remainder Court');
    const permit = await approved(s);
    const id = await lapsed(s, permit.id, '6000');
    const settled = await settle(s, permit.id, id).expect(200);
    const claim = claimOf(settled, id);
    expect(claim.settlement).toMatchObject({
      deducted: '5000.00',
      charged: '1000.00',
      chargeStatus: 'open',
    });
    expect(fitOut(settled).deposit?.held).toBe('0.00');
    const invoice = await p.v.inTx(s.c, (tx) =>
      tx.invoice.findUniqueOrThrow({
        where: { id: claim.settlement!.invoiceId! },
      }),
    );
    expect(invoice).toMatchObject({ unitId: s.home.id, kind: 'damage' });
    expect(invoice.total.toFixed(2)).toBe('1000.00');
  });

  it('with no deposit, all of it is owed as an invoice', async () => {
    const s = await p.setUp('Claims No Deposit Court');
    await p.setRules(s.manager, { worksDepositRequired: false });
    const permit = await approved(s);
    const id = await lapsed(s, permit.id, '800');
    expect(
      claimOf(await settle(s, permit.id, id).expect(200), id).settlement,
    ).toMatchObject({
      deducted: '0.00',
      charged: '800.00',
      chargeStatus: 'open',
    });
  });

  it('an accepted appeal withdraws it; the management withdraws an open one with a code; neither settles', async () => {
    const s = await p.setUp('Claims Withdrawn Court');
    const permit = await approved(s);
    const [first] = fitOut(await raise(s, permit.id).expect(201)).claims;
    await appeal(s, permit.id, first.id).expect(200);
    // Not withdrawn while under appeal: decided first.
    await p
      .http(
        'post',
        `${staff(permit.id)}/damage-claims/${first.id}/withdraw`,
        s.manager.token,
        { reasonCode: 'repaired_by_unit' },
      )
      .expect(409);
    expect(
      claimOf(
        await decide(s, permit.id, first.id, 'accepted').expect(200),
        first.id,
      ),
    ).toMatchObject({
      status: 'withdrawn',
      withdrawn: { reason: 'appeal_accepted' },
      appeal: { decision: 'accepted' },
    });
    expect(
      (await settle(s, permit.id, first.id).expect(409)).body,
    ).toMatchObject({
      code: 'DAMAGE_CLAIM_NOT_OPEN',
      params: { status: 'withdrawn' },
    });
    const second = fitOut(await raise(s, permit.id).expect(201)).claims[0];
    // `appeal_accepted` is the appeal's own.
    await p
      .http(
        'post',
        `${staff(permit.id)}/damage-claims/${second.id}/withdraw`,
        s.manager.token,
        { reasonCode: 'appeal_accepted' },
      )
      .expect(400);
    const withdrawn = await p
      .http(
        'post',
        `${staff(permit.id)}/damage-claims/${second.id}/withdraw`,
        s.manager.token,
        { reasonCode: 'issued_in_error' },
      )
      .expect(200);
    expect(claimOf(withdrawn, second.id)).toMatchObject({
      status: 'withdrawn',
      withdrawn: { reason: 'issued_in_error' },
    });
    expect(await p.told(s.c, s.alice.id, permit.id)).toContainEqual({
      kind: 'unit_permit.damage_withdrawn',
      params: { claimNumber: second.number, reason: 'issued_in_error' },
    });
  });

  it('a pending permit takes none; another unit’s household appeals none; a lapsed window takes no appeal', async () => {
    const s = await p.setUp('Claims Refused Court');
    const pending = await p.works(s.alice, s.home.id);
    expect((await raise(s, pending.id).expect(409)).body).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'pending' },
    });
    const permit = await approved(s);
    const [claim] = fitOut(await raise(s, permit.id).expect(201)).claims;
    const other = await p.v.unit(s.c, 'P2');
    const bob = await p.v.owner(s.c, other.id);
    await p
      .http(
        'post',
        `/permits/${permit.id}/damage-claims/${claim.id}/appeal`,
        bob.token,
        { text: 'Not ours.' },
      )
      .expect(404);
    const old = await lapsed(s, permit.id, '100');
    expect((await appeal(s, permit.id, old).expect(409)).body).toMatchObject({
      code: 'DAMAGE_CLAIM_NO_APPEAL',
      params: { status: 'open', appealed: false },
    });
  });

  it('the deposit is not refunded while a claim on the permit is open', async () => {
    const s = await p.setUp('Claims Refund Court');
    const permit = await approved(s);
    // The approval recorded the permit's deposit (the rule is on).
    const depositId = (
      await p.v.inTx(s.c, (tx) =>
        tx.financeDeposit.findFirstOrThrow({ where: { permitId: permit.id } }),
      )
    ).id;
    const id = await lapsed(s, permit.id, '1000');
    await f.stepUp(s.manager.token);
    expect(
      (
        await p
          .http(
            'post',
            `/staff/deposits/${depositId}/settle`,
            s.manager.token,
            {
              refund: { amount: '1000', channel: 'cash' },
            },
          )
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'DEPOSIT_CLAIM_OPEN', params: { claims: 1 } });
    await settle(s, permit.id, id).expect(200);
    await f.stepUp(s.manager.token);
    await p
      .http('post', `/staff/deposits/${depositId}/settle`, s.manager.token, {
        refund: { amount: '4000', channel: 'cash' },
      })
      .expect(200);
  });

  it('a settlement and a refund at once: the claim takes its part, the refund never more than is held', async () => {
    const s = await p.setUp('Claims Race Court');
    const permit = await approved(s);
    const depositId = (
      await p.v.inTx(s.c, (tx) =>
        tx.financeDeposit.findFirstOrThrow({ where: { permitId: permit.id } }),
      )
    ).id;
    const id = await lapsed(s, permit.id, '3000');
    // Two sessions of the manager's, each with its step-up.
    const other = (await p.v.who(s.c, s.manager.id, 'manager')).token;
    await f.stepUp(s.manager.token);
    await f.stepUp(other);
    const [settled, refund] = await Promise.all([
      p.http(
        'post',
        `${staff(permit.id)}/damage-claims/${id}/settle`,
        s.manager.token,
      ),
      p.http('post', `/staff/deposits/${depositId}/settle`, other, {
        refund: { amount: '5000', channel: 'cash' },
      }),
    ]);
    // Whichever came first, the claim is settled and the refund refused:
    // the claim was open, or the deposit holds less than was asked.
    expect(settled.status).toBe(200);
    expect(refund.status).toBe(409);
    expect(['DEPOSIT_CLAIM_OPEN', 'DEPOSIT_EXCEEDS_HELD']).toContain(
      (refund.body as { code: string }).code,
    );
    expect(fitOut(settled).claims[0].settlement?.deducted).toBe('3000.00');
    const events = await p.v.inTx(s.c, (tx) =>
      tx.financeDepositEvent.findMany({ where: { depositId } }),
    );
    expect(events.filter((e) => e.amount !== null).map((e) => e.kind)).toEqual([
      'deducted',
    ]);
  });

  it('two settlements at once: one, with one deduction', async () => {
    const s = await p.setUp('Claims Twice Court');
    const permit = await approved(s);
    const id = await lapsed(s, permit.id, '700');
    await f.stepUp(s.manager.token);
    const second = (await p.v.who(s.c, s.manager.id, 'manager')).token;
    await f.stepUp(second);
    const both = await Promise.all([
      p.http(
        'post',
        `${staff(permit.id)}/damage-claims/${id}/settle`,
        s.manager.token,
      ),
      p.http('post', `${staff(permit.id)}/damage-claims/${id}/settle`, second),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const deductions = await p.v.inTx(s.c, (tx) =>
      tx.financeDepositEvent.count({
        where: { kind: 'deducted', deposit: { permitId: permit.id } },
      }),
    );
    expect(deductions).toBe(1);
  });

  it('the appellant’s erasure takes their words and photo; the claim stays', async () => {
    const s = await p.setUp('Claims Erased Court');
    await p.setRules(s.manager, { worksDepositRequired: false });
    const created = await p.v.x.resident(s.c, [s.home.id]);
    const permit = await approved(s);
    const [claim] = fitOut(await raise(s, permit.id).expect(201)).claims;
    await p
      .http(
        'post',
        `/permits/${permit.id}/damage-claims/${claim.id}/appeal`,
        s.alice.token,
        {
          text: 'ERASE-ME words',
          photoFileId: await p.files.ready(
            s.alice.token,
            'damage_appeal_photo',
          ),
        },
      )
      .expect(200);
    // A primary's erasure waits for another primary (ADR 0023).
    await p.v.x.asManager(s.c, () =>
      h.moduleRef.get(ResidentsService).setPrimary(s.home.id, created.id),
    );
    await eraseNow(h, s.c, s.alice.id);
    const row = await p.v.inTx(s.c, (tx) =>
      tx.permitDamageClaim.findUniqueOrThrow({ where: { id: claim.id } }),
    );
    expect(row).toMatchObject({
      appealText: null,
      appealPhotoFileId: null,
      status: 'under_appeal',
    });
    expect(row.appealTextClearedAt).not.toBeNull();
    expect(
      (
        await read.tenant(s.c.tenantId, {
          action: 'damage_claim.appeal_cleared',
          targetId: claim.id,
        })
      ).map((r) => r.metadata),
    ).toEqual([{ permitId: permit.id, photo: true }]);
  });
});
