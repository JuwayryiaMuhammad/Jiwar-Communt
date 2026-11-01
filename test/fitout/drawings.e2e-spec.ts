import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred, permitHelpers, type PermitSetUp } from '../setup/permits';

interface FitOutBody {
  permitId: string;
  reference: string;
  status: string;
  depositRequired: boolean;
  deposit: { number: string; amount: string; held: string } | null;
  drawings: {
    id: string;
    addedAt: string;
    file: { url: string; expiresAt: string } | null;
  }[];
}

/**
 * A works permit's drawings (ADR 0074): its requester or the unit's
 * primary joins them while the permit is open, ten at once at most, and
 * takes one off; the management reads them with the permit's fit-out.
 */
describe('Fit-out — drawings', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const drawing = (s: PermitSetUp, contentType = 'image/png') =>
    p.files.ready(s.alice.token, 'permit_drawing', contentType);
  const add = (s: PermitSetUp, permitId: string, fileId?: string) =>
    deferred(
      (async () =>
        p.http('post', `/permits/${permitId}/drawings`, s.alice.token, {
          fileId: fileId ?? (await drawing(s)),
        }))(),
    );
  const fitOut = (res: { body: unknown }) => res.body as FitOutBody;

  it('joined by the requester, an image or a PDF; the management reads them; audited by ids and counts', async () => {
    const s = await p.setUp('Drawings Court');
    const permit = await p.works(s.alice, s.home.id);
    const first = await add(s, permit.id).expect(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(Object.keys(fitOut(first)).sort()).toEqual([
      'areas',
      'certificateBlockedBy',
      'claims',
      'debrisSlots',
      'deposit',
      'depositRequired',
      'drawings',
      'permitId',
      'reference',
      'status',
    ]);
    expect(fitOut(first)).toMatchObject({
      permitId: permit.id,
      reference: permit.reference,
      status: 'pending',
      depositRequired: true,
      deposit: null,
    });
    await add(s, permit.id, await drawing(s, 'application/pdf')).expect(201);
    const staff = fitOut(
      await p
        .http(
          'get',
          `/staff/unit-permits/${permit.id}/fit-out`,
          s.manager.token,
        )
        .expect(200),
    );
    expect(staff.drawings).toHaveLength(2);
    for (const d of staff.drawings) expect(d.file?.url).toBeTruthy();
    const rows = await read.tenant(s.c.tenantId, {
      action: 'permit_drawing.added',
      targetId: permit.id,
    });
    expect(rows.map((r) => r.metadata)).toEqual([
      { permitId: permit.id, drawingId: staff.drawings[0].id, drawings: 1 },
      { permitId: permit.id, drawingId: staff.drawings[1].id, drawings: 2 },
    ]);
  });

  it('ten at once at most; one taken off frees a place, and the file stays the record’s', async () => {
    const s = await p.setUp('Drawings Limit Court');
    const permit = await p.works(s.alice, s.home.id);
    for (let i = 0; i < 10; i++) await add(s, permit.id).expect(201);
    const over = await add(s, permit.id).expect(409);
    expect(over.body).toMatchObject({
      code: 'PERMIT_DRAWING_LIMIT',
      params: { max: 10 },
    });
    const [gone] = fitOut(
      await p.http('get', `/permits/${permit.id}/fit-out`, s.alice.token),
    ).drawings;
    const after = await p
      .http(
        'post',
        `/permits/${permit.id}/drawings/${gone.id}/remove`,
        s.alice.token,
      )
      .expect(200);
    expect(fitOut(after).drawings.map((d) => d.id)).not.toContain(gone.id);
    expect(
      (
        await p
          .http(
            'post',
            `/permits/${permit.id}/drawings/${gone.id}/remove`,
            s.alice.token,
          )
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'PERMIT_DRAWING_NOT_FOUND' });
    await add(s, permit.id).expect(201);
    const row = await p.v.inTx(s.c, (tx) =>
      tx.permitDrawing.findUniqueOrThrow({ where: { id: gone.id } }),
    );
    expect(row.removedAt).not.toBeNull();
    const file = await p.v.inTx(s.c, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: row.fileId } }),
    );
    expect(file.deletedAt).toBeNull();
  });

  it('a works permit of the caller’s household only, while it is open, with a drawing of theirs', async () => {
    const s = await p.setUp('Drawings Access Court');
    const other = await p.v.unit(s.c, 'P2');
    const bob = await p.v.owner(s.c, other.id);
    const permit = await p.works(s.alice, s.home.id);
    // Another unit's owner: not found, reading or writing.
    await p.http('get', `/permits/${permit.id}/fit-out`, bob.token).expect(404);
    expect(
      (
        await p
          .http('post', `/permits/${permit.id}/drawings`, bob.token, {
            fileId: await p.files.ready(bob.token, 'permit_drawing'),
          })
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'PERMIT_NOT_FOUND' });
    // A move permit has no fit-out.
    const move = await p.move(s.alice, s.home.id);
    await p
      .http('get', `/permits/${move.id}/fit-out`, s.alice.token)
      .expect(404);
    // Another purpose's file, or another's file: not found.
    expect(
      (
        await add(
          s,
          permit.id,
          await p.files.ready(s.alice.token, 'permit_photo'),
        ).expect(404)
      ).body,
    ).toMatchObject({ code: 'FILE_NOT_FOUND' });
    // Cancelled: closed.
    await p
      .http('post', `/permits/${permit.id}/cancel`, s.alice.token, {})
      .expect(200);
    expect((await add(s, permit.id).expect(409)).body).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'cancelled' },
    });
  });

  it('the fit-out names the deposit the management recorded for the permit', async () => {
    const s = await p.setUp('Drawings Deposit Court');
    const permit = await p.works(s.alice, s.home.id);
    const deposit = await p.deposit(s.manager, permit.id);
    expect(
      fitOut(
        await p
          .http('get', `/permits/${permit.id}/fit-out`, s.alice.token)
          .expect(200),
      ).deposit,
    ).toEqual({ number: deposit.number, amount: '5000.00', held: '5000.00' });
  });
});
