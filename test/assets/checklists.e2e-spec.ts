import { err } from '../api/request';
import { attestation } from '../../src/maintenance/checklists/checklist-rules';
import { fileHelpers } from '../setup/files';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Run = {
  id: string;
  version: number;
  status: 'open' | 'submitted';
  submittedAt: string | null;
  submittedById: string | null;
  attestationSha256: string | null;
  items: {
    id: string;
    position: number;
    kind: string;
    answer: {
      result: string | null;
      value: string | null;
      note: string | null;
      photos: { id: string }[];
    } | null;
  }[];
};

/**
 * ADR 0064: checklists. Items are versioned (a run keeps the version it
 * took); a technician answers while working and submits once, with every
 * required item; a reading out of range fails; the attestation is the
 * SHA-256 of exactly what was submitted, and the database keeps it so;
 * the ticket is not completed while its checklist is open; readings land
 * on the asset.
 */
describe('Assets — checklists', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const tech = () => s.techs[0].token;
  const run = async (ticketId: string) =>
    (
      await a
        .http('get', `/technician/tickets/${ticketId}/checklist`, tech())
        .expect(200)
    ).body as Run;
  const answer = (ticketId: string, itemId: string, body: object) =>
    a.http(
      'put',
      `/technician/tickets/${ticketId}/checklist/items/${itemId}`,
      tech(),
      body,
    );
  const submit = (ticketId: string) =>
    a.http('post', `/technician/tickets/${ticketId}/checklist/submit`, tech());

  const ITEMS = [
    {
      kind: 'check',
      labelAr: 'تسريب',
      labelEn: 'No leaks',
      failCreatesTicket: false,
    },
    {
      kind: 'reading',
      labelAr: 'الضغط',
      labelEn: 'Pressure',
      metricKey: 'pressure_bar',
      unit: 'bar',
      minValue: '2',
      maxValue: '4',
    },
    {
      kind: 'photo',
      labelAr: 'صورة',
      labelEn: 'Photo of the gauge',
      required: false,
    },
    { kind: 'text', labelAr: 'ملاحظات', labelEn: 'Notes', required: false },
  ];

  it('answered while working, submitted once with every required item; readings on the asset; attested', async () => {
    const assetId = await a.asset(s);
    const cl = await a.checklist(s, ITEMS);
    const ticketId = await a.jobWithChecklist(s, assetId, cl.id);
    const [check, reading, photo] = cl.items;
    // Not before the required ones are answered.
    await submit(ticketId)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'CHECKLIST_INCOMPLETE',
          params: { positions: [1, 2] },
        }),
      );
    await answer(ticketId, check.id, { result: 'pass' }).expect(200);
    await answer(ticketId, check.id, {
      result: 'fail',
      note: 'A drip at the valve',
    }).expect(200);
    await answer(ticketId, reading.id, { result: 'pass' })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'value', code: 'FIELD_REQUIRED' },
          { field: 'result', code: 'FIELD_NOT_ALLOWED' },
        ]),
      );
    const out = (
      await answer(ticketId, reading.id, { value: '4.5' }).expect(200)
    ).body as Run;
    expect(out.items[1].answer).toMatchObject({
      result: 'fail',
      value: '4.5000',
    });
    const fileId = await fileHelpers(h).ready(tech(), 'checklist_photo');
    await answer(ticketId, photo.id, { photoFileIds: [fileId] }).expect(200);
    // The ticket waits for its checklist.
    await a
      .http('post', `/technician/tickets/${ticketId}/complete`, tech())
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('CHECKLIST_NOT_SUBMITTED'));
    const submitted = (await submit(ticketId).expect(201)).body as Run;
    expect(submitted).toMatchObject({
      status: 'submitted',
      submittedById: s.techs[0].id,
    });
    // The hash is exactly what was submitted.
    expect(submitted.attestationSha256).toBe(
      attestation({
        runId: submitted.id,
        templateId: cl.id,
        version: 1,
        submittedById: s.techs[0].id,
        submittedAt: new Date(submitted.submittedAt!),
        answers: [
          {
            itemId: check.id,
            position: 1,
            result: 'fail',
            value: null,
            note: 'A drip at the valve',
            photoFileIds: [],
          },
          {
            itemId: reading.id,
            position: 2,
            result: 'fail',
            value: '4.5000',
            note: null,
            photoFileIds: [],
          },
          {
            itemId: photo.id,
            position: 3,
            result: null,
            value: null,
            note: null,
            photoFileIds: [fileId],
          },
        ],
      }),
    );
    // Never again: no answer, no second submission, and not in the database.
    await answer(ticketId, check.id, { result: 'pass' })
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('CHECKLIST_RUN_SUBMITTED'));
    await submit(ticketId).expect(409);
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE checklist_answers SET note = 'edited' WHERE run_id = ${submitted.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE checklist_runs SET attestation_sha256 = repeat('0', 64) WHERE id = ${submitted.id}::uuid`,
      ),
    ).rejects.toThrow();
    const readings = await a.inTenant(s.c, (tx) =>
      tx.assetReading.findMany({ where: { assetId } }),
    );
    expect(
      readings.map((r) => [
        r.metricKey,
        r.value.toFixed(1),
        r.unit,
        r.source,
        r.runId,
      ]),
    ).toEqual([['pressure_bar', '4.5', 'bar', 'run', submitted.id]]);
    await a
      .http('post', `/technician/tickets/${ticketId}/complete`, tech())
      .expect(204);
    // Dispatch reads it too.
    await a
      .http(
        'get',
        `/maintenance/tickets/${ticketId}/checklist`,
        s.supervisor.token,
      )
      .expect(200);
  });

  it('new items are a new version; an open run keeps the one it took', async () => {
    const assetId = await a.asset(s);
    const cl = await a.checklist(s);
    const ticketId = await a.jobWithChecklist(s, assetId, cl.id);
    const replaced = (
      await a
        .http(
          'put',
          `/maintenance/checklists/${cl.id}/items`,
          s.manager.token,
          {
            items: [
              { kind: 'check', labelAr: 'أ', labelEn: 'First' },
              { kind: 'check', labelAr: 'ب', labelEn: 'Second' },
            ],
          },
        )
        .expect(200)
    ).body as { version: number; items: unknown[] };
    expect(replaced).toMatchObject({ version: 2, items: [{}, {}] });
    const open = await run(ticketId);
    expect(open).toMatchObject({ version: 1 });
    expect(open.items).toHaveLength(1);
    // An item of the new version is not this run's.
    const item = (replaced.items as { id: string }[])[0].id;
    await answer(ticketId, item, { result: 'pass' })
      .expect(404)
      .expect((r) => expect(err(r).code).toBe('CHECKLIST_ITEM_NOT_FOUND'));
    // The old version's items stay in the database, as they were.
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE checklist_template_items SET label_en = 'x' WHERE template_id = ${cl.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('three photos an answer at most, even sent at once; a file of another purpose is not one', async () => {
    const assetId = await a.asset(s);
    const cl = await a.checklist(s, [
      { kind: 'photo', labelAr: 'ص', labelEn: 'Photos' },
    ]);
    const ticketId = await a.jobWithChecklist(s, assetId, cl.id);
    const files = fileHelpers(h);
    const photos = await Promise.all(
      [0, 1, 2, 3].map(() => files.ready(tech(), 'checklist_photo')),
    );
    const results = await Promise.all(
      photos.map((id) =>
        answer(ticketId, cl.items[0].id, { photoFileIds: [id] }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 409]);
    expect((await run(ticketId)).items[0].answer!.photos).toHaveLength(3);
    const other = await files.ready(tech(), 'ticket_photo');
    const fresh = await a.jobWithChecklist(s, await a.asset(s), cl.id);
    await answer(fresh, cl.items[0].id, { photoFileIds: [other] })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'photoFileIds.0', code: 'FILE_NOT_AVAILABLE' },
        ]),
      );
  });

  it('an answer racing the submission: either it is in the attested answers, or it is refused', async () => {
    for (let round = 0; round < 3; round++) {
      const assetId = await a.asset(s);
      const cl = await a.checklist(s, [
        { kind: 'check', labelAr: 'أ', labelEn: 'A' },
        { kind: 'text', labelAr: 'ن', labelEn: 'Note', required: false },
      ]);
      const ticketId = await a.jobWithChecklist(s, assetId, cl.id);
      await answer(ticketId, cl.items[0].id, { result: 'pass' }).expect(200);
      const [late, done] = await Promise.all([
        answer(ticketId, cl.items[1].id, { note: 'racing' }),
        submit(ticketId),
      ]);
      expect(done.status).toBe(201);
      const final = await run(ticketId);
      const noted = final.items[1].answer?.note === 'racing';
      expect([late.status, noted]).toEqual(noted ? [200, true] : [409, false]);
    }
  });

  it('only the ticket’s technician, only while working; another compound’s ticket is not found', async () => {
    const assetId = await a.asset(s);
    const cl = await a.checklist(s);
    const ticketId = await a.jobWithChecklist(s, assetId, cl.id);
    await a
      .http(
        'get',
        `/technician/tickets/${ticketId}/checklist`,
        s.supervisor.token,
      )
      .expect(403);
    await a
      .http('post', `/technician/tickets/${ticketId}/hold`, tech(), {
        holdReason: 'awaiting_parts',
      })
      .expect(204);
    await answer(ticketId, cl.items[0].id, { result: 'pass' }).expect(200);
    const other = await a.setUp(1);
    const theirs = await a.jobWithChecklist(
      other,
      await a.asset(other),
      (await a.checklist(other)).id,
    );
    await a
      .http('get', `/technician/tickets/${theirs}/checklist`, tech())
      .expect(404)
      .expect((r) => expect(err(r).code).toBe('TICKET_NOT_FOUND'));
  });
});
