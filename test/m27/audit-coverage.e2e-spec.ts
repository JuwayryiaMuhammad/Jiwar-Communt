import { Client } from 'pg';
import { AUDIT_ACTIONS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M27_COVERAGE } from '../setup/audit-coverage-split';
import { day, dbClock } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { nationalIdFor, uniquePhone, uniqueSuffix } from '../setup/fixtures';
import { fileHelpers } from '../setup/files';
import {
  createHttpHarness,
  uniqueEmail,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';

const MARKER = 'AUDIT-m27-secret';
const HOUR = 3_600_000;

/**
 * One scenario per entry of ADR 0088's catalog: actor, target and metadata
 * — ids, codes and instants; a dispatcher's note and a tender's title and
 * scope as changed only; a bid's amount never before its tender is opened.
 */
const covered = new Set<string>();

describe('Audit coverage — the contractor portal and tenders (ADR 0088)', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let accountant: { id: string; token: string };
  let vendorId: string;
  let contractor: { id: string; token: string };
  let migrator: Client;

  const http = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => d.http(method, path, token, body);
  const m = () => s.manager.token;

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }
  /** A published tender's deadline moved to just past (see the tenders suite). */
  const closeBids = async (tenderId: string) => {
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
                bids_due_at = clock_timestamp() - interval '1 second'
          WHERE id = $1::uuid`,
        [tenderId],
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
  const draft = async () =>
    (
      (
        await http('post', '/staff/tenders', m(), {
          title: `${MARKER} tender`,
          scope: `${MARKER} scope`,
          category: 'maintenance',
          contractKind: 'service',
          bidsDueAt: new Date(dbClock().getTime() + 48 * HOUR).toISOString(),
        }).expect(201)
      ).body as { id: string }
    ).id;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    read = auditReaders(h);
    s = await d.setUp(1);
    accountant = await d.who(
      s.c,
      (await d.g.guard(s.c, 'accountant')).id,
      'staff',
    );
    vendorId = (
      (
        await http('post', '/staff/vendors', m(), {
          name: `Audit Builders ${uniqueSuffix()}`,
        }).expect(201)
      ).body as { id: string }
    ).id;
    const res = await http(
      'post',
      `/staff/vendors/${vendorId}/contractors`,
      m(),
      {
        fullName: 'Audit Contractor',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(new Date('1985-07-07')),
        phone: uniquePhone(),
        email: uniqueEmail('audit-contractor'),
      },
    ).expect(201);
    const id = (res.body as { id: string }).id;
    contractor = {
      id,
      token: await h.tokenFor({
        sub: id,
        tid: s.c.tenantId,
        typ: 'contractor',
      }),
    };
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await migrator.connect();
  }, 240_000);

  afterAll(async () => {
    await migrator.end();
    await h.close();
  });

  it('a ticket offered to a vendor, taken, turned down and taken back', async () => {
    const offer = async (note?: string) => {
      const ticketId = await d.openTicket(s);
      const o = (
        await http(
          'post',
          `/maintenance/tickets/${ticketId}/vendor-dispatch`,
          s.supervisor.token,
          { vendorId, ...(note ? { note } : {}) },
        ).expect(201)
      ).body as { id: string };
      return { ticketId, dispatchId: o.id };
    };
    const a = await offer(`${MARKER} bring a ladder`);
    const offered = await single('vendor_dispatch.offered', a.dispatchId);
    expect(offered).toMatchObject({
      actorId: s.supervisor.id,
      changes: { note: { changed: true } },
      metadata: { ticketId: a.ticketId, vendorId },
    });
    await http(
      'post',
      `/contractor/dispatches/${a.dispatchId}/accept`,
      contractor.token,
    ).expect(200);
    expect(
      await single('vendor_dispatch.accepted', a.dispatchId),
    ).toMatchObject({
      actorId: contractor.id,
      metadata: { ticketId: a.ticketId, vendorId },
    });

    const b = await offer();
    await http(
      'post',
      `/contractor/dispatches/${b.dispatchId}/decline`,
      contractor.token,
      { reasonCode: 'too_far' },
    ).expect(204);
    expect(
      await single('vendor_dispatch.declined', b.dispatchId),
    ).toMatchObject({
      metadata: { reasonCode: 'too_far' },
    });

    const c = await offer();
    await http(
      'post',
      `/maintenance/tickets/${c.ticketId}/vendor-dispatch/withdraw`,
      s.supervisor.token,
      { reasonCode: 'not_needed' },
    ).expect(204);
    expect(
      await single('vendor_dispatch.withdrawn', c.dispatchId),
    ).toMatchObject({
      metadata: { reasonCode: 'not_needed' },
    });
  });

  it('a tender drafted, changed, documented, published, invited, bid on, opened by two and awarded', async () => {
    const id = await draft();
    expect(await single('tender.created', id)).toMatchObject({
      actorId: s.manager.id,
      changes: { title: { changed: true }, scope: { changed: true } },
    });
    await http('patch', `/staff/tenders/${id}`, m(), {
      title: `${MARKER} tender, again`,
    }).expect(200);
    expect(await single('tender.updated', id)).toMatchObject({
      changes: { title: { changed: true } },
    });
    const fileId = await fileHelpers(h).ready(
      m(),
      'tender_document',
      'application/pdf',
    );
    const withDoc = (
      await http('post', `/staff/tenders/${id}/documents`, m(), {
        fileId,
        title: `${MARKER} drawings`,
      }).expect(201)
    ).body as { documents: { id: string }[] };
    expect(await single('tender.document_added', id)).toMatchObject({
      metadata: { documentId: withDoc.documents[0].id },
    });
    await http(
      'delete',
      `/staff/tenders/${id}/documents/${withDoc.documents[0].id}`,
      m(),
    ).expect(200);
    expect(await single('tender.document_removed', id)).toBeTruthy();

    const invited = (
      await http('post', `/staff/tenders/${id}/invitations`, m(), {
        vendorId,
      }).expect(201)
    ).body as { id: string };
    expect(await single('tender_invitation.created', invited.id)).toMatchObject(
      { metadata: { tenderId: id, kind: 'vendor', vendorId } },
    );
    await http('post', `/staff/tenders/${id}/publish`, m()).expect(200);
    expect(await single('tender.published', id)).toMatchObject({
      metadata: { invitations: 1 },
    });

    const linked = (
      await http('post', `/staff/tenders/${id}/invitations`, m(), {
        companyName: `${MARKER} Outside Co.`,
      }).expect(201)
    ).body as { url: string; invitation: { id: string } };
    const token = linked.url.split('#')[1];
    await h
      .http()
      .post('/api/v1/public/tender-bids/lookup')
      .send({ token })
      .expect(200);
    expect(
      await single('tender_invitation.link_opened', linked.invitation.id),
    ).toMatchObject({ actorType: 'system' });
    await http(
      'post',
      `/staff/tenders/${id}/invitations/${linked.invitation.id}/revoke`,
      m(),
    ).expect(200);
    expect(
      await single('tender_invitation.revoked', linked.invitation.id),
    ).toMatchObject({ metadata: { kind: 'link' } });

    const first = (
      await http('post', `/contractor/tenders/${id}/bid`, contractor.token, {
        amount: '1234.00',
      }).expect(201)
    ).body as { bid: { id: string } };
    const submitted = await single('tender_bid.submitted', first.bid.id);
    expect(JSON.stringify(submitted)).not.toContain('1234');
    await http(
      'post',
      `/contractor/tenders/${id}/bid/withdraw`,
      contractor.token,
    ).expect(204);
    expect(await single('tender_bid.withdrawn', first.bid.id)).toBeTruthy();
    const second = (
      await http('post', `/contractor/tenders/${id}/bid`, contractor.token, {
        amount: '1200.00',
      }).expect(201)
    ).body as { bid: { id: string } };

    await closeBids(id);
    await http('post', `/staff/tenders/${id}/opening`, accountant.token).expect(
      200,
    );
    expect(await single('tender.opening_started', id)).toMatchObject({
      actorId: accountant.id,
      metadata: { startedById: accountant.id },
    });
    await http('post', `/staff/tenders/${id}/opening`, m()).expect(200);
    expect(await single('tender.opened', id)).toMatchObject({
      metadata: {
        startedById: accountant.id,
        confirmedById: s.manager.id,
        bidCount: 1,
      },
    });
    await http('post', `/staff/tenders/${id}/award`, m(), {
      bidId: second.bid.id,
      code: `AU-${uniqueSuffix()}`,
      startsOn: day(5),
      endsOn: day(100),
    }).expect(200);
    expect(await single('tender.awarded', id)).toMatchObject({
      metadata: { bidId: second.bid.id, vendorId, amount: '1200.00' },
    });
  });

  it('a tender called off', async () => {
    const id = await draft();
    await http('post', `/staff/tenders/${id}/cancel`, m(), {
      reasonCode: 'rescoped',
    }).expect(200);
    expect(await single('tender.cancelled', id)).toMatchObject({
      metadata: { reasonCode: 'rescoped', from: 'draft' },
    });
  });

  it('covers every entry of its list, and the list names only catalog actions', () => {
    for (const k of M27_COVERAGE)
      expect(Object.keys(AUDIT_ACTIONS)).toContain(k);
    expect([...covered].sort()).toEqual([...M27_COVERAGE].sort());
  });
});
