import { AUDIT_ACTIONS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M25_COVERAGE } from '../setup/audit-coverage-split';
import { budgetHelpers } from '../setup/budgets';
import { clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m25-secret';

/**
 * One scenario per entry of ADR 0077's catalog: actor, target and metadata
 * — numbers, codes, ids, amounts and days; a vendor's names, contacts and
 * notes, a purchase request's words and a decision's note as changed only.
 */
const covered = new Set<string>();

describe('Audit coverage — vendors, contracts and purchase requests (ADR 0077)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    read = auditReaders(h);
    s = await f.setUp(4, 3);
  }, 240_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  it('vendor.created, .updated, .suspended, .reinstated — numbers and codes; the names and contacts as changed', async () => {
    const v = (
      await f
        .http('post', '/staff/vendors', m(), {
          name: `${MARKER} ${uniqueSuffix()}`,
          contactName: `${MARKER} contact`,
          notes: MARKER,
        })
        .expect(201)
    ).body as { id: string };
    expect(await single('vendor.created', v.id)).toMatchObject({
      actorId: s.manager.id,
      changes: { name: { changed: true }, contactName: { changed: true } },
    });
    await f
      .http('patch', `/staff/vendors/${v.id}`, m(), {
        notes: `${MARKER} again`,
        categories: ['security'],
      })
      .expect(200);
    expect(await single('vendor.updated', v.id)).toMatchObject({
      changes: {
        notes: { changed: true },
        categories: { from: 'other', to: 'security' },
      },
    });
    await f
      .http('post', `/staff/vendors/${v.id}/suspend`, m(), {
        reasonCode: 'fraud',
      })
      .expect(200);
    expect(await single('vendor.suspended', v.id)).toMatchObject({
      metadata: { reasonCode: 'fraud' },
    });
    await f.http('post', `/staff/vendors/${v.id}/reinstate`, m()).expect(200);
    expect(await single('vendor.reinstated', v.id)).toMatchObject({
      metadata: { suspendedFor: 'fraud' },
    });
  });

  it('vendor.document_added, .document_removed and .evaluated — kinds, days and scores; the note as changed', async () => {
    const v = (
      await f
        .http('post', '/staff/vendors', m(), {
          name: `Papers ${uniqueSuffix()}`,
        })
        .expect(201)
    ).body as { id: string };
    const d = (
      await f
        .http('post', `/staff/vendors/${v.id}/documents`, m(), {
          kind: 'tax_card',
          fileId: await f.files.ready(
            m(),
            'vendor_document',
            'application/pdf',
          ),
          expiresOn: day(90),
        })
        .expect(201)
    ).body as { id: string };
    expect(await single('vendor.document_added', v.id)).toMatchObject({
      metadata: { documentId: d.id, kind: 'tax_card', expiresOn: day(90) },
    });
    await f
      .http('delete', `/staff/vendors/${v.id}/documents/${d.id}`, m())
      .expect(204);
    expect(await single('vendor.document_removed', v.id)).toMatchObject({
      metadata: { documentId: d.id, kind: 'tax_card' },
    });
    await f
      .http('post', `/staff/vendors/${v.id}/evaluations`, m(), {
        quality: 2,
        timeliness: 3,
        cost: 4,
        communication: 5,
        safety: 1,
        note: MARKER,
      })
      .expect(201);
    expect(await single('vendor.evaluated', v.id)).toMatchObject({
      metadata: { quality: 2, safety: 1, contractId: null },
      changes: { note: { changed: true } },
    });
  });

  it('maintenance_contract.renewed, .payments_scheduled and .payment_paid — ids, counts, amounts and days', async () => {
    const c = (
      await f
        .http('post', '/maintenance/contracts', m(), {
          code: `A-${uniqueSuffix()}`,
          kind: 'cleaning',
          vendorName: `Cleaners ${uniqueSuffix()}`,
          penaltyTerms: MARKER,
          startsOn: day(-10),
          endsOn: day(100),
        })
        .expect(201)
    ).body as { id: string };
    const [p] = (
      (
        await f
          .http('put', `/maintenance/contracts/${c.id}/payments`, m(), {
            payments: [{ dueOn: day(5), amount: '1500', note: MARKER }],
          })
          .expect(200)
      ).body as { data: { id: string }[] }
    ).data;
    expect(
      await single('maintenance_contract.payments_scheduled', c.id),
    ).toMatchObject({
      metadata: { payments: 1, total: '1500.00', removed: 0 },
    });
    await f
      .http(
        'post',
        `/maintenance/contracts/${c.id}/payments/${p.id}/pay`,
        m(),
        {
          paidOn: clock().today,
          reference: 'EX-1',
        },
      )
      .expect(200);
    expect(
      await single('maintenance_contract.payment_paid', c.id),
    ).toMatchObject({
      metadata: { paymentId: p.id, amount: '1500.00', dueOn: day(5) },
    });
    const r = (
      await f
        .http('post', `/maintenance/contracts/${c.id}/renew`, m(), {
          code: `B-${uniqueSuffix()}`,
          endsOn: day(500),
        })
        .expect(201)
    ).body as { id: string };
    expect(await single('maintenance_contract.renewed', c.id)).toMatchObject({
      metadata: { renewalId: r.id, assets: 0 },
    });
  });

  it('purchase_request.submitted, .approved, .rejected, .cancelled and .fulfilled — numbers, amounts and codes; the words as changed', async () => {
    const ask = async () =>
      (
        (
          await f
            .http('post', '/staff/purchase-requests', s.accountant.token, {
              title: `${MARKER} title`,
              description: MARKER,
              estimatedAmount: '900',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
    const a = await ask();
    expect(await single('purchase_request.submitted', a)).toMatchObject({
      actorId: s.accountant.id,
      changes: { title: { changed: true }, description: { changed: true } },
      metadata: { estimatedAmount: '900.00' },
    });
    await f
      .http('post', `/staff/purchase-requests/${a}/approve`, m(), {
        note: MARKER,
      })
      .expect(200);
    expect(await single('purchase_request.approved', a)).toMatchObject({
      metadata: { approvalRequestId: null },
      changes: { decisionNote: { changed: true } },
    });
    await f
      .http('post', `/staff/purchase-requests/${a}/fulfil`, m(), {
        reference: 'EX-9',
      })
      .expect(200);
    expect(await single('purchase_request.fulfilled', a)).toMatchObject({
      metadata: { reference: 'EX-9' },
    });
    const b = await ask();
    await f
      .http('post', `/staff/purchase-requests/${b}/reject`, m(), {
        reasonCode: 'too_costly',
      })
      .expect(200);
    expect(await single('purchase_request.rejected', b)).toMatchObject({
      metadata: { reasonCode: 'too_costly' },
    });
    const c = await ask();
    await f
      .http(
        'post',
        `/staff/purchase-requests/${c}/cancel`,
        s.accountant.token,
        {
          reasonCode: 'not_needed',
        },
      )
      .expect(200);
    expect(await single('purchase_request.cancelled', c)).toMatchObject({
      metadata: { reasonCode: 'not_needed', from: 'requested' },
    });
  });

  it('covers every entry of its list, and the list names only catalog actions', () => {
    for (const k of M25_COVERAGE)
      expect(Object.keys(AUDIT_ACTIONS)).toContain(k);
    expect([...covered].sort()).toEqual([...M25_COVERAGE].sort());
  });
});
