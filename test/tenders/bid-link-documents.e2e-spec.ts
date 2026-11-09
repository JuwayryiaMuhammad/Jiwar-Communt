import type Redis from 'ioredis';
import { Client } from 'pg';
import { REDIS } from '../../src/core/redis/redis.token';
import { err } from '../api/request';
import { auditReaders } from '../setup/audit';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { dbClock } from '../setup/compound-clock';
import { SAMPLE } from '../setup/files';
import { nationalIdFor, uniquePhone, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  type HttpHarness,
} from '../setup/http-app';
import { deferred } from '../setup/permits';
import { required } from '../setup/test-env';

type Who = { id: string; token: string };
interface Doc {
  id: string;
  title: string;
  contentType: string;
  ready: boolean;
  sent: boolean;
}
interface Page {
  status: string;
  bid: { id: string; withdrawnAt: string | null } | null;
  bidDocuments: Doc[];
  maxBidDocuments: number;
}
interface StaffTender {
  status: string;
  bids: {
    id: string;
    sealed: boolean;
    withdrawnAt: string | null;
    documents: { id: string; title: string; fileUrl: string | null }[];
  }[];
}

const HOUR = 3_600_000;

/**
 * ADR 0088, deviation 4 closed: a company invited by a bid link attaches
 * documents to its bid with no account. Each is a `tender_bid` record
 * upload through the link: started, its bytes PUT, finalized; a draft
 * until the bid names it, removed while a draft, deleted with a withdrawn
 * bid. Sealed as the amount: nobody on the compound's side reads one, and
 * no link to one exists, before the opening; after it, they come with the
 * bid. Audited by ids and counts; isolated by compound.
 */
describe('A bid link’s documents (ADR 0088)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  let migrator: Client;
  let ann: Who;
  let vendorId: string;

  const http = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  /**
   * A link call. The link's limits (30 a minute per IP, 20 per link) are
   * the tenders suite's to prove; this suite makes many calls on one link
   * and starts each with a fresh window.
   */
  const pub = (path: string, body: object) =>
    deferred(
      (async () => {
        const redis = h.moduleRef.get<Redis>(REDIS);
        const keys = await redis.keys('rl:tender-bid:*');
        if (keys.length) await redis.del(...keys);
        return h.http().post(`/api/v1/public/tender-bids/${path}`).send(body);
      })(),
    );
  const pdf = SAMPLE['application/pdf'];
  const png = SAMPLE['image/png'];

  const published = async () => {
    const t = (
      await http('post', '/staff/tenders', m(), {
        title: `Lift renewal ${uniqueSuffix()}`,
        scope: 'Replace the two lifts of building A.',
        category: 'maintenance',
        contractKind: 'service',
        budgetLineId: budget.lines[0].id,
        estimatedValue: '50000.00',
        bidsDueAt: new Date(dbClock().getTime() + 48 * HOUR).toISOString(),
      }).expect(201)
    ).body as { id: string };
    const res = await http('post', `/staff/tenders/${t.id}/invitations`, m(), {
      companyName: `Outside ${uniqueSuffix()}`,
    }).expect(201);
    const body = res.body as { url: string; invitation: { id: string } };
    await http('post', `/staff/tenders/${t.id}/publish`, m()).expect(200);
    return {
      id: t.id,
      token: body.url.split('#')[1],
      invitationId: body.invitation.id,
    };
  };
  /** Started; with `put`, its bytes up. Its file's id. */
  const upload = async (
    token: string,
    title = 'The offer',
    bytes: Buffer = pdf,
    contentType = 'application/pdf',
    put = true,
  ) => {
    const res = await pub('uploads', {
      token,
      title,
      contentType,
      size: bytes.length,
    }).expect(201);
    const body = res.body as {
      document: Doc;
      upload: { url: string; method: string; headers: Record<string, string> };
    };
    expect(body.document).toMatchObject({
      title,
      contentType,
      ready: false,
      sent: false,
    });
    if (put) {
      const r = await fetch(body.upload.url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
        headers: body.upload.headers,
      });
      expect(r.ok).toBe(true);
    }
    return body.document.id;
  };
  const ready = async (
    token: string,
    title?: string,
    bytes?: Buffer,
    type?: string,
  ) => {
    const id = await upload(token, title, bytes, type);
    expect(
      (await pub(`documents/${id}/finalize`, { token }).expect(200)).body,
    ).toMatchObject({ id, ready: true, sent: false });
    return id;
  };
  const page = async (token: string) =>
    (await pub('lookup', { token }).expect(200)).body as Page;
  const staff = async (id: string) =>
    (await http('get', `/staff/tenders/${id}`, m()).expect(200))
      .body as StaffTender;
  /** The tenant audit rows of an action on a target, as the tenant reads them. */
  const audits = async (action: string, targetId: string) =>
    (await auditReaders(h).tenant(s.c.tenantId, { action, targetId })).map(
      (row) => ({ metadata: row.metadata as Record<string, unknown> }),
    );
  const fileRow = async (id: string) =>
    (
      await migrator.query<{ deleted: boolean; exists: boolean }>(
        `SELECT (deleted_at IS NOT NULL) AS deleted, true AS exists FROM files WHERE id = $1`,
        [id],
      )
    ).rows[0] ?? { deleted: true, exists: false };
  /** Moves the deadline to just past (see the tenders suite). */
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
  const open = async (tenderId: string) => {
    await closeBids(tenderId);
    await http('post', `/staff/tenders/${tenderId}/opening`, acc()).expect(200);
    await http('post', `/staff/tenders/${tenderId}/opening`, m()).expect(200);
  };

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'maintenance', amount: '900000.00' }],
    );
    vendorId = (
      (
        await http('post', '/staff/vendors', m(), {
          name: `Builders ${uniqueSuffix()}`,
          categories: ['maintenance'],
        }).expect(201)
      ).body as { id: string }
    ).id;
    const res = await http(
      'post',
      `/staff/vendors/${vendorId}/contractors`,
      m(),
      {
        fullName: 'Registered Bidder',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(new Date('1987-04-04')),
        phone: uniquePhone(),
        email: uniqueEmail('bid-docs'),
      },
    ).expect(201);
    const id = (res.body as { id: string }).id;
    ann = {
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
    await migrator?.end();
    await h?.close();
  });

  it('uploaded through the link, finalized, the bid carries what it names; the rest are deleted', async () => {
    const t = await published();
    const offer = await ready(t.token, 'Priced offer');
    const drawing = await ready(t.token, 'Drawing', png, 'image/png');
    const spare = await ready(t.token, 'Spare copy');
    // Never served: the company's page lists them without a link.
    const before = await page(t.token);
    expect(before.maxBidDocuments).toBe(20);
    expect(before.bidDocuments.map((d) => d.id)).toEqual([
      offer,
      drawing,
      spare,
    ]);
    expect(JSON.stringify(before.bidDocuments)).not.toMatch(/https?:/);

    const sent = (
      await pub('bid', {
        token: t.token,
        amount: '48000.00',
        fileIds: [offer, drawing],
      }).expect(200)
    ).body as Page;
    expect(sent.bidDocuments).toEqual([
      expect.objectContaining({ id: offer, sent: true, ready: true }),
      expect.objectContaining({ id: drawing, sent: true, ready: true }),
    ]);
    expect(await fileRow(spare)).toMatchObject({ deleted: true });
    const [audit] = await audits('tender_bid.submitted', sent.bid!.id);
    expect(audit.metadata).toMatchObject({
      via: 'link',
      withDocument: true,
      documentCount: 2,
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('Priced offer');

    // A sent bid's documents are not drafts: not removed, no more added.
    expect(
      err(await pub(`documents/${offer}/remove`, { token: t.token })),
    ).toMatchObject({ statusCode: 404, code: 'TENDER_BID_DOCUMENT_NOT_FOUND' });
    expect(
      err(
        await pub('uploads', {
          token: t.token,
          title: 'Late addition',
          contentType: 'application/pdf',
          size: pdf.length,
        }),
      ),
    ).toMatchObject({ statusCode: 409, code: 'TENDER_BID_EXISTS' });
  });

  it('sealed as the amount: no document and no link before the opening; after it, with the bid', async () => {
    const t = await published();
    const offer = await ready(t.token, 'Sealed offer');
    const sent = (
      await pub('bid', {
        token: t.token,
        amount: '51000.00',
        fileIds: [offer],
      }).expect(200)
    ).body as Page;
    const sealed = await staff(t.id);
    const bid = sealed.bids.find((b) => b.id === sent.bid!.id)!;
    expect(bid).toMatchObject({ sealed: true, documents: [] });
    expect(JSON.stringify(sealed)).not.toContain(offer);
    // No other way in: the file has no owner, so no staff member reads it.
    await http('get', `/files/${offer}`, m()).expect(404);
    await http('get', `/files/${offer}`, acc()).expect(404);

    await open(t.id);
    const opened = await staff(t.id);
    const unsealed = opened.bids.find((b) => b.id === sent.bid!.id)!;
    expect(unsealed.sealed).toBe(false);
    expect(unsealed.documents).toEqual([
      {
        id: offer,
        title: 'Sealed offer',
        fileUrl: expect.stringMatching(/^https?:/) as string,
      },
    ]);
    const read = await fetch(unsealed.documents[0].fileUrl!);
    expect(Buffer.from(await read.arrayBuffer()).equals(pdf)).toBe(true);
  });

  it('a withdrawn bid takes its documents with it, and so does a revocation', async () => {
    const t = await published();
    const offer = await ready(t.token, 'First offer');
    await pub('bid', {
      token: t.token,
      amount: '47000.00',
      fileIds: [offer],
    }).expect(200);
    await pub('withdraw', { token: t.token }).expect(204);
    expect(await fileRow(offer)).toMatchObject({ deleted: true });
    const after = await page(t.token);
    expect(after.bid).toMatchObject({
      withdrawnAt: expect.any(String) as string,
    });
    expect(after.bidDocuments).toEqual([]);
    const [withdrawn] = await audits('tender_bid.withdrawn', after.bid!.id);
    expect(withdrawn.metadata).toMatchObject({
      via: 'link',
      documentsWithdrawn: 1,
    });

    // A second bid with a new document, then the invitation revoked while
    // bids are taken: the bid is withdrawn, its document deleted.
    const again = await ready(t.token, 'Second offer');
    await pub('bid', {
      token: t.token,
      amount: '46000.00',
      fileIds: [again],
    }).expect(200);
    await http(
      'post',
      `/staff/tenders/${t.id}/invitations/${t.invitationId}/revoke`,
      m(),
    ).expect(200);
    expect(await fileRow(again)).toMatchObject({ deleted: true });
    const [revoked] = await audits('tender_invitation.revoked', t.invitationId);
    expect(revoked.metadata).toMatchObject({
      withdrawn: 1,
      documentsWithdrawn: 1,
    });
    await pub('lookup', { token: t.token }).expect(404);
  });

  it('a draft is removed; refused: a wrong file, too many, another link’s, a late one, a contractor’s', async () => {
    const t = await published();
    // Removed: its file goes, its removal audited by ids only.
    const wrong = await ready(t.token, 'Wrong file');
    await pub(`documents/${wrong}/remove`, { token: t.token }).expect(204);
    expect(await fileRow(wrong)).toMatchObject({ exists: false });
    expect((await page(t.token)).bidDocuments).toEqual([]);

    // Bytes that are not what was declared: deleted at the finalize.
    const fake = await upload(t.token, 'Not a PDF', png, 'application/pdf');
    expect(
      err(await pub(`documents/${fake}/finalize`, { token: t.token })),
    ).toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
    // A type or a size the purpose refuses never starts.
    expect(
      err(
        await pub('uploads', {
          token: t.token,
          title: 'A sheet',
          contentType: 'text/csv',
          size: 10,
        }),
      ),
    ).toMatchObject({
      statusCode: 400,
      fields: [
        expect.objectContaining({
          field: 'contentType',
          code: 'FILE_TYPE_NOT_ALLOWED',
        }),
      ],
    });
    expect(
      err(
        await pub('uploads', {
          token: t.token,
          title: 'Too big',
          contentType: 'application/pdf',
          size: 10 * 1024 * 1024 + 1,
        }),
      ),
    ).toMatchObject({
      statusCode: 400,
      fields: [
        expect.objectContaining({ field: 'size', code: 'FILE_TOO_LARGE' }),
      ],
    });

    // An upload that never arrived is not sendable.
    const pending = await upload(
      t.token,
      'Never sent',
      pdf,
      'application/pdf',
      false,
    );
    expect(
      err(
        await pub('bid', {
          token: t.token,
          amount: '1000.00',
          fileIds: [pending],
        }),
      ),
    ).toMatchObject({
      statusCode: 400,
      fields: [{ field: 'fileIds', code: 'FILE_NOT_AVAILABLE' }],
    });

    // Another link's document is not this link's.
    const other = await published();
    const theirs = await ready(other.token, 'Their offer');
    expect(
      err(await pub(`documents/${theirs}/remove`, { token: t.token })),
    ).toMatchObject({ statusCode: 404, code: 'TENDER_BID_DOCUMENT_NOT_FOUND' });
    expect(
      err(
        await pub('bid', {
          token: t.token,
          amount: '1000.00',
          fileIds: [theirs],
        }),
      ),
    ).toMatchObject({
      fields: [{ field: 'fileIds', code: 'FILE_NOT_AVAILABLE' }],
    });

    // Twenty at most, uploads in flight included (one is in flight above).
    for (let i = 0; i < 19; i++)
      await upload(t.token, `Page ${i}`, pdf, 'application/pdf', false);
    expect(
      err(
        await pub('uploads', {
          token: t.token,
          title: 'One too many',
          contentType: 'application/pdf',
          size: pdf.length,
        }),
      ),
    ).toMatchObject({
      statusCode: 409,
      code: 'TENDER_BID_DOCUMENT_LIMIT',
      params: { limit: 20 },
    });

    // A registered vendor's contractor cannot take a link's document: it
    // is no account's file.
    const late = await published();
    const linkDoc = await ready(late.token, 'Link offer');
    await http('post', `/staff/tenders/${late.id}/invitations`, m(), {
      vendorId,
    }).expect(201);
    expect(
      err(
        await http('post', `/contractor/tenders/${late.id}/bid`, ann.token, {
          amount: '900.00',
          fileId: linkDoc,
        }),
      ),
    ).toMatchObject({
      statusCode: 400,
      fields: [{ field: 'fileId', code: 'FILE_NOT_AVAILABLE' }],
    });

    // Past the deadline: nothing is added or removed.
    await closeBids(late.id);
    expect(
      err(
        await pub('uploads', {
          token: late.token,
          title: 'Late',
          contentType: 'application/pdf',
          size: pdf.length,
        }),
      ),
    ).toMatchObject({ statusCode: 409, code: 'TENDER_CLOSED' });
    expect(
      err(await pub(`documents/${linkDoc}/remove`, { token: late.token })),
    ).toMatchObject({ statusCode: 409, code: 'TENDER_CLOSED' });
  });

  it('isolated by compound: another compound reads no row of them', async () => {
    const t = await published();
    const doc = await ready(t.token, 'Isolated offer');
    const other = await h.createTenant(`Bid docs other ${uniqueSuffix()}`);
    // As the app's role, which RLS binds (the migrator owns the table).
    const app = new Client({ connectionString: required('TEST_DATABASE_URL') });
    await app.connect();
    const count = async (tenantId: string) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        const { rows } = await app.query<{ n: string }>(
          'SELECT count(*) AS n FROM tender_bid_documents WHERE file_id = $1',
          [doc],
        );
        return Number(rows[0].n);
      } finally {
        await app.query('ROLLBACK');
      }
    };
    try {
      expect(await count(s.c.tenantId)).toBe(1);
      expect(await count(other.id)).toBe(0);
    } finally {
      await app.end();
    }
  });
});
