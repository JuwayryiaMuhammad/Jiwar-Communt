import { Client } from 'pg';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { day } from '../setup/compound-clock';
import { dbClock } from '../setup/compound-clock';
import { nationalIdFor, uniquePhone, uniqueSuffix } from '../setup/fixtures';
import { fileHelpers } from '../setup/files';
import {
  createHttpHarness,
  uniqueEmail,
  type HttpHarness,
} from '../setup/http-app';
import { deferred } from '../setup/permits';
import { required } from '../setup/test-env';

type Who = { id: string; token: string };
interface Tender {
  id: string;
  reference: string;
  status: string;
  bidsDueAt: string;
  bidCount: number | null;
  openingStartedById: string | null;
  openedById: string | null;
  contractId: string | null;
  invitations: { id: string; kind: string; name: string | null }[];
  bids: {
    id: string;
    invitationId: string;
    sealed: boolean;
    amount: string | null;
    note: string | null;
    withdrawnAt: string | null;
  }[];
  documents: { id: string; title: string }[];
}
interface Invitee {
  id: string;
  status: string;
  bid: { id: string; sealed: boolean; amount: string | null } | null;
  outcome: string | null;
  documents: { id: string }[];
}

const HOUR = 3_600_000;

/**
 * ADR 0088: tenders with their documents, invited vendors (registered: their
 * contractors bid; not registered: a time-limited bid link of this tender
 * alone), sealed bids nobody reads before the opening, an opening by two
 * different people, and an award that signs the compound's contract with
 * the winner under the board's approval above the manager's limit — with
 * the races where two writers meet. And a vendor's contractor sending its
 * invoices in by the contractor channel (ADR 0089's table).
 */
describe('Tenders and the contractor’s invoices (ADR 0088)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let files: ReturnType<typeof fileHelpers>;
  let vendorId: string;
  let ann: Who;
  let bea: Who;
  let migrator: Client;

  const http = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const pub = (path: string, body: object) =>
    h.http().post(`/api/v1/public/tender-bids/${path}`).send(body);

  const vendor = async () =>
    (
      (
        await http('post', '/staff/vendors', m(), {
          name: `Builders ${uniqueSuffix()}`,
          categories: ['maintenance'],
        }).expect(201)
      ).body as { id: string }
    ).id;
  const contractor = async (v: string): Promise<Who> => {
    const res = await http('post', `/staff/vendors/${v}/contractors`, m(), {
      fullName: 'Bidding Contractor',
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(new Date('1988-03-03')),
      phone: uniquePhone(),
      email: uniqueEmail('bidder'),
    }).expect(201);
    const id = (res.body as { id: string }).id;
    return {
      id,
      token: await h.tokenFor({
        sub: id,
        tid: s.c.tenantId,
        typ: 'contractor',
      }),
    };
  };
  const draft = async (over: object = {}) =>
    (
      await http('post', '/staff/tenders', m(), {
        title: 'Facade repair, building B',
        scope: 'Strip and re-render the east facade.',
        category: 'maintenance',
        contractKind: 'service',
        budgetLineId: budget.lines[0].id,
        estimatedValue: '80000.00',
        bidsDueAt: new Date(dbClock().getTime() + 48 * HOUR).toISOString(),
        ...over,
      }).expect(201)
    ).body as Tender;
  const tenderOf = async (id: string) =>
    (await http('get', `/staff/tenders/${id}`, m()).expect(200)).body as Tender;
  const published = async () => {
    const t = await draft();
    await http('post', `/staff/tenders/${t.id}/invitations`, m(), {
      vendorId,
    }).expect(201);
    await http('post', `/staff/tenders/${t.id}/publish`, m()).expect(200);
    return t;
  };
  const link = async (
    tenderId: string,
    companyName = `Outside ${uniqueSuffix()}`,
  ) => {
    const res = await http(
      'post',
      `/staff/tenders/${tenderId}/invitations`,
      m(),
      {
        companyName,
      },
    ).expect(201);
    const body = res.body as { url: string; invitation: { id: string } };
    return { token: body.url.split('#')[1], invitationId: body.invitation.id };
  };
  const bid = (tenderId: string, who: Who, amount: string) =>
    http('post', `/contractor/tenders/${tenderId}/bid`, who.token, {
      amount,
      durationDays: 60,
    });
  /**
   * Moves a published tender's deadline to just past (as the migrator, the
   * trigger set aside for that one statement, in one transaction): the
   * database's clock cannot be wound on.
   */
  const closeBids = async (tenderId: string, offsetMs = -1000) => {
    await migrator.query('BEGIN');
    try {
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await migrator.query(
        'ALTER TABLE tenders DISABLE TRIGGER tenders_move_forward',
      );
      await migrator.query(
        `UPDATE tenders
            SET created_at = LEAST(created_at, clock_timestamp() - interval '1 hour'),
                bids_due_at = clock_timestamp() + ($2::int * interval '1 millisecond')
          WHERE id = $1::uuid`,
        [tenderId, offsetMs],
      );
      await migrator.query(
        'ALTER TABLE tenders ENABLE TRIGGER tenders_move_forward',
      );
      await migrator.query('COMMIT');
    } catch (e) {
      await migrator.query('ROLLBACK');
      throw e;
    }
  };
  const setThreshold = (threshold: string | null) =>
    http('patch', '/staff/governance/settings', m(), {
      items: [{ type: 'major_contract', threshold }],
    }).expect(200);

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    files = fileHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'maintenance', amount: '900000.00' }],
    );
    vendorId = await vendor();
    ann = await contractor(vendorId);
    bea = await contractor(await vendor());
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await migrator.connect();
  }, 240_000);

  afterAll(async () => {
    await migrator.end();
    await h.close();
  });

  describe('a tender', () => {
    it('a draft changes; published, its terms are fixed and its deadline only moves later', async () => {
      const t = await draft();
      expect(t).toMatchObject({ status: 'draft' });
      expect(t.reference).toMatch(/^TN-\d{6}$/);
      await http('patch', `/staff/tenders/${t.id}`, m(), {
        title: 'Facade repair, B and C',
      }).expect(200);
      await http('post', `/staff/tenders/${t.id}/publish`, m()).expect(200);
      expect(
        err(
          await http('patch', `/staff/tenders/${t.id}`, m(), {
            title: 'Other',
          }),
        ),
      ).toMatchObject({ status: 409, code: 'TENDER_STATE' });
      const later = new Date(dbClock().getTime() + 72 * HOUR).toISOString();
      await http('post', `/staff/tenders/${t.id}/deadline`, m(), {
        bidsDueAt: later,
      }).expect(200);
      expect(
        err(
          await http('post', `/staff/tenders/${t.id}/deadline`, m(), {
            bidsDueAt: new Date(dbClock().getTime() + 50 * HOUR).toISOString(),
          }),
        ),
      ).toMatchObject({ status: 400 });
    });

    it('a document is the tender keeper’s file; an invitee reads it', async () => {
      const t = await published();
      const fileId = await files.ready(
        m(),
        'tender_document',
        'application/pdf',
      );
      const r = await http('post', `/staff/tenders/${t.id}/documents`, m(), {
        fileId,
        title: 'Bill of quantities',
      }).expect(201);
      expect((r.body as Tender).documents).toHaveLength(1);
      const seen = (
        await http('get', `/contractor/tenders/${t.id}`, ann.token).expect(200)
      ).body as Invitee;
      expect(seen.documents).toHaveLength(1);
      // Not invited: nothing, as for an unknown id.
      expect(
        err(await http('get', `/contractor/tenders/${t.id}`, bea.token)),
      ).toMatchObject({ status: 404, code: 'TENDER_NOT_FOUND' });
    });
  });

  describe('sealed bids', () => {
    it('nobody reads an amount before the opening: not the manager, not the bidder, not the app’s role', async () => {
      const t = await published();
      const r = await bid(t.id, ann, '75000.00').expect(201);
      expect((r.body as Invitee).bid).toMatchObject({
        sealed: true,
        amount: null,
      });
      const staff = await tenderOf(t.id);
      expect(staff.bids).toHaveLength(1);
      expect(staff.bids[0]).toMatchObject({
        sealed: true,
        amount: null,
        note: null,
      });
      expect(JSON.stringify(staff)).not.toContain('75000');
      // The database's own seal: the app's role cannot select it.
      await expect(
        f.inTx(
          s.c,
          (tx) =>
            tx.$queryRaw`SELECT sealed_amount FROM tender_bids WHERE tender_id = ${t.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/);
      const audit = await f.inTx(s.c, (tx) =>
        tx.auditLog.findMany({ where: { targetId: staff.bids[0].id } }),
      );
      expect(JSON.stringify(audit)).not.toContain('75000');
      // One live bid; withdrawn, another may be sent.
      expect(err(await bid(t.id, ann, '74000.00'))).toMatchObject({
        status: 409,
        code: 'TENDER_BID_EXISTS',
      });
      await http(
        'post',
        `/contractor/tenders/${t.id}/bid/withdraw`,
        ann.token,
      ).expect(204);
      await bid(t.id, ann, '74000.00').expect(201);
    });

    it('a bid after the deadline is late; the opening waits for the deadline', async () => {
      const t = await published();
      expect(
        err(await http('post', `/staff/tenders/${t.id}/opening`, acc())),
      ).toMatchObject({ status: 409, code: 'TENDER_NOT_DUE' });
      await closeBids(t.id);
      expect(err(await bid(t.id, ann, '70000.00'))).toMatchObject({
        status: 409,
        code: 'TENDER_CLOSED',
      });
    });
  });

  describe('the bid link', () => {
    it('opens its tender alone, takes one bid, and opens nothing once revoked', async () => {
      const t = await published();
      const l = await link(t.id, 'Outside Builders');
      const page = await pub('lookup', { token: l.token }).expect(200);
      expect(page.body).toMatchObject({
        id: t.id,
        companyName: 'Outside Builders',
        status: 'open',
        bid: null,
      });
      expect(JSON.stringify(page.body)).not.toMatch(
        /80000|estimatedValue|invitations/,
      );
      await pub('bid', { token: l.token, amount: '69000.00' }).expect(200);
      expect(
        err(await pub('bid', { token: l.token, amount: '68000.00' })),
      ).toMatchObject({ status: 409, code: 'TENDER_BID_EXISTS' });
      await http(
        'post',
        `/staff/tenders/${t.id}/invitations/${l.invitationId}/revoke`,
        m(),
      ).expect(200);
      for (const body of [
        { token: l.token },
        { token: 'x'.repeat(43) },
        { token: 'short' },
      ])
        expect(err(await pub('lookup', body))).toMatchObject({
          status: 404,
          code: 'TENDER_LINK_NOT_FOUND',
        });
      // Its bid went with it while bids were taken.
      expect(
        (await tenderOf(t.id)).bids.every(
          (b) => b.withdrawnAt !== null || b.invitationId !== l.invitationId,
        ),
      ).toBe(true);
    });

    it('a new link stops the one before at once', async () => {
      const t = await published();
      const l = await link(t.id);
      const r = await http(
        'post',
        `/staff/tenders/${t.id}/invitations/${l.invitationId}/link`,
        m(),
      ).expect(201);
      const fresh = (r.body as { url: string }).url.split('#')[1];
      expect(err(await pub('lookup', { token: l.token }))).toMatchObject({
        status: 404,
      });
      await pub('lookup', { token: fresh }).expect(200);
    });
  });

  describe('the opening and the award', () => {
    it('two different people open it; the one who began never confirms; the bids are unsealed then', async () => {
      const t = await published();
      await bid(t.id, ann, '72000.00').expect(201);
      const l = await link(t.id);
      await pub('bid', { token: l.token, amount: '71000.00' }).expect(200);
      await closeBids(t.id);
      const first = (
        await http('post', `/staff/tenders/${t.id}/opening`, acc()).expect(200)
      ).body as Tender;
      expect(first).toMatchObject({
        status: 'opening',
        openingStartedById: s.accountant.id,
      });
      expect(first.bids.every((b) => b.sealed)).toBe(true);
      expect(
        err(await http('post', `/staff/tenders/${t.id}/opening`, acc())),
      ).toMatchObject({ status: 409, code: 'TENDER_OPENING_SAME_PERSON' });
      const opened = (
        await http('post', `/staff/tenders/${t.id}/opening`, m()).expect(200)
      ).body as Tender;
      expect(opened).toMatchObject({
        status: 'opened',
        openedById: s.manager.id,
        bidCount: 2,
      });
      expect(opened.bids.map((b) => b.amount).sort()).toEqual([
        '71000.00',
        '72000.00',
      ]);
      // The database keeps the two apart too.
      await expect(
        f.inTx(s.c, (tx) =>
          tx.tender.update({
            where: { id: t.id },
            data: { openedById: s.accountant.id },
          }),
        ),
      ).rejects.toThrow();
    });

    it('the award signs the contract with the winner — a link bidder registered — under the board’s approval above the limit, which signs no other', async () => {
      await setThreshold('50000.00');
      const t = await published();
      const l = await link(t.id, `Newcomer ${uniqueSuffix()}`);
      await pub('bid', { token: l.token, amount: '60000.00' }).expect(200);
      await bid(t.id, ann, '65000.00').expect(201);
      await closeBids(t.id);
      await http('post', `/staff/tenders/${t.id}/opening`, acc()).expect(200);
      const opened = (
        await http('post', `/staff/tenders/${t.id}/opening`, m()).expect(200)
      ).body as Tender;
      const winner = opened.bids.find(
        (b) => b.invitationId === l.invitationId,
      )!;
      const award = (body: object = {}) =>
        http('post', `/staff/tenders/${t.id}/award`, m(), {
          bidId: winner.id,
          code: `TC-${uniqueSuffix()}`,
          startsOn: day(10),
          endsOn: day(200),
          ...body,
        });
      expect(err(await award())).toMatchObject({
        status: 409,
        code: 'CONTRACT_NEEDS_APPROVAL',
      });
      const r = await f.raise(s.manager, {
        type: 'major_contract',
        cost: '60000.00',
        context: 'The facade',
      });
      await f.approve([s.owners[0], s.owners[1]], r.id);
      const done = (await award({ approvalRequestId: r.id }).expect(200))
        .body as Tender;
      expect(done.status).toBe('awarded');
      const contract = await f.inTx(s.c, (tx) =>
        tx.maintenanceContract.findUniqueOrThrow({
          where: { id: done.contractId! },
        }),
      );
      expect(contract).toMatchObject({
        approvalRequestId: r.id,
        kind: 'service',
      });
      expect(contract.annualValue?.toFixed(2)).toBe('60000.00');
      const v = await f.inTx(s.c, (tx) =>
        tx.vendor.findUniqueOrThrow({ where: { id: contract.vendorId } }),
      );
      expect(v.name).toMatch(/^Newcomer/);
      // The same approval signs no second contract.
      const again = await http('post', '/maintenance/contracts', m(), {
        code: `TC-${uniqueSuffix()}`,
        kind: 'service',
        vendorId,
        startsOn: day(10),
        endsOn: day(200),
        annualValue: '60000.00',
        approvalRequestId: r.id,
      });
      expect(err(again)).toMatchObject({
        status: 409,
        code: 'CONTRACT_APPROVAL_INVALID',
        params: { reason: 'signs_another' },
      });
      // The registered loser's contractors are told it went to another.
      const told = await f.inTx(s.c, (tx) =>
        tx.notification.findFirst({
          where: { accountId: ann.id, kind: 'tender.decided', targetId: t.id },
        }),
      );
      expect(told?.params).toMatchObject({ outcome: 'not_awarded' });
      await setThreshold(null);
    });
  });

  describe('races', () => {
    it('two openings at once: one begins, the other confirms; the same person twice: one begins, one refused (×3)', async () => {
      for (let round = 0; round < 3; round++) {
        const t = await published();
        await bid(t.id, ann, '50000.00').expect(201);
        await closeBids(t.id);
        const [x, y] = await Promise.all([
          http('post', `/staff/tenders/${t.id}/opening`, acc()),
          http('post', `/staff/tenders/${t.id}/opening`, m()),
        ]);
        expect([x.status, y.status]).toEqual([200, 200]);
        const final = await tenderOf(t.id);
        expect(final.status).toBe('opened');
        expect(final.openingStartedById).not.toBe(final.openedById);

        const t2 = await published();
        await closeBids(t2.id);
        const both = await Promise.all([
          http('post', `/staff/tenders/${t2.id}/opening`, acc()),
          http('post', `/staff/tenders/${t2.id}/opening`, acc()),
        ]);
        expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
        expect((await tenderOf(t2.id)).status).toBe('opening');
      }
    });

    it('bids around the deadline and the opening: every bid taken is opened, every other was late (×3)', async () => {
      for (let round = 0; round < 3; round++) {
        const t = await published();
        const links = await Promise.all([link(t.id), link(t.id), link(t.id)]);
        await closeBids(t.id, 400);
        const sent = links.map((l, i) =>
          new Promise((r) => setTimeout(r, i * 250)).then(() =>
            pub('bid', { token: l.token, amount: `${40000 + i}.00` }),
          ),
        );
        // The opening as soon as the deadline lets it: before, TENDER_NOT_DUE.
        const opening = (async () => {
          await new Promise((r) => setTimeout(r, 300));
          for (;;) {
            const r = await http(
              'post',
              `/staff/tenders/${t.id}/opening`,
              acc(),
            );
            if (r.status !== 409 || err(r).code !== 'TENDER_NOT_DUE') return r;
            await new Promise((x) => setTimeout(x, 25));
          }
        })();
        const results = await Promise.all(sent);
        expect((await opening).status).toBe(200);
        for (const r of results)
          if (r.status !== 200)
            expect(err(r)).toMatchObject({
              status: 409,
              code: 'TENDER_CLOSED',
            });
        await http('post', `/staff/tenders/${t.id}/opening`, m()).expect(200);
        const opened = await tenderOf(t.id);
        expect(opened.bidCount).toBe(
          results.filter((r) => r.status === 200).length,
        );
        expect(
          opened.bids.filter((b) => !b.withdrawnAt).every((b) => !b.sealed),
        ).toBe(true);
      }
    });

    it('two awards at once: one contract (×3)', async () => {
      for (let round = 0; round < 3; round++) {
        const t = await published();
        await bid(t.id, ann, '30000.00').expect(201);
        await closeBids(t.id);
        await http('post', `/staff/tenders/${t.id}/opening`, acc()).expect(200);
        const opened = (
          await http('post', `/staff/tenders/${t.id}/opening`, m()).expect(200)
        ).body as Tender;
        const award = () =>
          http('post', `/staff/tenders/${t.id}/award`, m(), {
            bidId: opened.bids[0].id,
            code: `TA-${uniqueSuffix()}`,
            startsOn: day(5),
            endsOn: day(100),
          });
        const both = await Promise.all([award(), award()]);
        expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
        const contracts = await f.inTx(s.c, (tx) =>
          tx.tender.findUniqueOrThrow({ where: { id: t.id } }),
        );
        expect(contracts.contractId).not.toBeNull();
      }
    });

    it('a link used as it is revoked: the bid is in and withdrawn with it, or refused (×3)', async () => {
      for (let round = 0; round < 3; round++) {
        const t = await published();
        const l = await link(t.id);
        const [b, r] = await Promise.all([
          pub('bid', { token: l.token, amount: '20000.00' }),
          http(
            'post',
            `/staff/tenders/${t.id}/invitations/${l.invitationId}/revoke`,
            m(),
          ),
        ]);
        expect(r.status).toBe(200);
        if (b.status !== 200) expect(b.status).toBe(404);
        const live = (await tenderOf(t.id)).bids.filter(
          (x) => x.invitationId === l.invitationId && !x.withdrawnAt,
        );
        expect(live).toHaveLength(0);
        expect(err(await pub('lookup', { token: l.token }))).toMatchObject({
          status: 404,
        });
      }
    });
  });

  describe('the contractor’s invoices', () => {
    it('sent in by the contractor channel against its own vendor’s contract, approved by the office as any', async () => {
      const contract = (
        await http('post', '/maintenance/contracts', m(), {
          code: `CI-${uniqueSuffix()}`,
          kind: 'amc',
          vendorId,
          startsOn: budget.startsOn,
          endsOn: budget.endsOn,
          annualValue: '12000.00',
          budgetLineId: budget.lines[0].id,
        }).expect(201)
      ).body as { id: string };
      const send = (body: object = {}) =>
        deferred(
          (async () =>
            http('post', '/contractor/invoices', ann.token, {
              vendorNumber: `F-${uniqueSuffix()}`,
              issuedOn: day(0),
              dueOn: day(15),
              contractId: contract.id,
              invoiceFileId: await files.ready(
                ann.token,
                'expense_invoice',
                'application/pdf',
              ),
              lines: [{ description: 'Quarterly service', amount: '3000.00' }],
              ...body,
            }))(),
        );
      const sent = (await send().expect(201)).body as {
        id: string;
        status: string;
      };
      expect(sent.status).toBe('received');
      const row = await f.inTx(s.c, (tx) =>
        tx.financeVendorInvoice.findUniqueOrThrow({ where: { id: sent.id } }),
      );
      expect(row).toMatchObject({
        channel: 'contractor',
        vendorId,
        recordedById: ann.id,
      });
      // Another vendor's contract: as unknown.
      const other = (
        await http('post', '/maintenance/contracts', m(), {
          code: `CO-${uniqueSuffix()}`,
          kind: 'amc',
          vendorId: await vendor(),
          startsOn: budget.startsOn,
          endsOn: budget.endsOn,
        }).expect(201)
      ).body as { id: string };
      expect(err(await send({ contractId: other.id }))).toMatchObject({
        status: 404,
        code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
      });
      // The office approves it as any vendor's invoice.
      await http(
        'post',
        `/staff/finance/vendor-invoices/${sent.id}/approve`,
        m(),
        {},
      ).expect(200);
      const mine = await http('get', '/contractor/invoices', ann.token).expect(
        200,
      );
      expect(
        (mine.body as { data: { id: string; status: string }[] }).data,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: sent.id, status: 'approved' }),
        ]),
      );
      // The database keeps the channel to a contractor of that very vendor.
      await expect(
        f.inTx(s.c, (tx) =>
          tx.financeVendorInvoice.create({
            data: {
              ...row,
              id: '00000000-0000-4000-8000-000000000001',
              number: row.number + 100000,
              vendorNumber: 'FORGED-1',
              invoiceFileId: '00000000-0000-4000-8000-000000000002',
              channel: 'office',
              status: 'received',
              decidedAt: null,
              decidedById: null,
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
