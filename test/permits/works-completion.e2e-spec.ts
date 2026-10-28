import { fileHelpers } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type Who } from '../setup/permits';

interface InspectionBody {
  id: string;
  cycle: number;
  status: string;
  findings: string[];
  certificateNumber: string | null;
  verifyCode: string | null;
  code?: string;
}

/**
 * Works completion (ADR 0063): the requester of an approved works permit
 * asks for the finished works to be inspected; the management fails them
 * with findings (asked again: a new cycle) or passes them, which issues the
 * completion certificate — a PDF, and a public check by its code.
 */
describe('Works completion', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who | null,
    body?: object,
  ) => {
    const req = h.http()[method](`${API}${path}`);
    return (who ? req.set('Authorization', `Bearer ${who.token}`) : req).send(
      body,
    );
  };
  const codeOf = (res: { body: unknown }) => (res.body as InspectionBody).code;
  type SetUp = Awaited<ReturnType<typeof p.setUp>>;

  /** An approved works permit of the home, asked by alice: its id. */
  async function approved(s: SetUp): Promise<string> {
    const permit = await p.works(s.alice, s.home.id);
    await p.approve(s.manager, permit.id);
    return permit.id;
  }
  const ask = (s: SetUp, permitId: string) =>
    http('post', `/permits/${permitId}/completion-inspection`, s.alice);
  const photo = (s: SetUp) =>
    fileHelpers(h).ready(s.manager.token, 'works_inspection_photo');
  const decide = async (
    s: SetUp,
    id: string,
    outcome: 'passed' | 'failed',
    findings?: string[],
  ) =>
    http('post', `/staff/permit-inspections/${id}/decide`, s.manager, {
      outcome,
      photoFileIds: [await photo(s)],
      ...(findings ? { findings } : {}),
    });

  it('failed with findings, asked again, passed: the certificate as a PDF and its public check', async () => {
    const s = await p.setUp('Works Completion Court');
    const permitId = await approved(s);
    const first = (await ask(s, permitId).expect(201)).body as InspectionBody;
    expect(first).toMatchObject({ cycle: 1, status: 'asked' });
    expect(codeOf(await ask(s, permitId))).toBe('PERMIT_INSPECTION_OPEN');
    expect(await p.told(s.c, s.manager.id, first.id)).toEqual([
      { kind: 'permit_inspection.requested', params: { cycle: 1 } },
    ]);

    // A failure says what, from the closed list.
    expect((await decide(s, first.id, 'failed')).status).toBe(400);
    expect(
      (await decide(s, first.id, 'failed', ['works_unfinished'])).body,
    ).toMatchObject({ status: 'failed', findings: ['works_unfinished'] });
    expect(codeOf(await decide(s, first.id, 'passed'))).toBe(
      'PERMIT_INSPECTION_DECIDED',
    );
    expect(await p.told(s.c, s.alice.id, first.id)).toEqual([
      { kind: 'permit_inspection.decided', params: { outcome: 'failed' } },
    ]);

    const second = (await ask(s, permitId).expect(201)).body as InspectionBody;
    expect(second.cycle).toBe(2);
    const passed = (await decide(s, second.id, 'passed'))
      .body as InspectionBody;
    expect(passed).toMatchObject({ status: 'passed', findings: [] });
    expect(passed.certificateNumber).toMatch(/^WC-\d{6}$/);
    expect(codeOf(await ask(s, permitId))).toBe(
      'PERMIT_INSPECTION_NOT_ALLOWED',
    );

    const file = await http(
      'get',
      `/permits/${permitId}/completion-certificate`,
      s.alice,
    )
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['cache-control']).toBe('no-store');
    expect((file.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const check = await http(
      'post',
      '/public/works-certificates/lookup',
      null,
      {
        code: passed.verifyCode,
      },
    ).expect(200);
    expect(Object.keys(check.body as object).sort()).toEqual([
      'compoundName',
      'number',
      'passedAt',
      'unitCode',
    ]);
    expect(check.body).toMatchObject({ number: passed.certificateNumber });
    await http('post', '/public/works-certificates/lookup', null, {
      code: 'A'.repeat(22),
    }).expect(404);
  });

  it('only an approved works permit, by its requester', async () => {
    const s = await p.setUp('Works Completion Rules');
    const pending = await p.works(s.alice, s.home.id);
    expect(codeOf(await ask(s, pending.id))).toBe(
      'PERMIT_INSPECTION_NOT_ALLOWED',
    );
    const member = await p.family(s.c, s.home.id, s.alice);
    expect(
      (
        await http(
          'post',
          `/permits/${pending.id}/completion-inspection`,
          member,
        )
      ).status,
    ).toBe(404);
  });

  it('an inspection is decided once and never goes', async () => {
    const s = await p.setUp('Works Completion Schema');
    const permitId = await approved(s);
    const asked = (await ask(s, permitId).expect(201)).body as InspectionBody;
    await decide(s, asked.id, 'failed', ['debris_left']);
    await expect(
      p.v.inTx(s.c, (tx) =>
        tx.permitInspection.update({
          where: { id: asked.id },
          data: { findings: ['other'] },
        }),
      ),
    ).rejects.toThrow(/permit_inspections/);
  });

  it('race: two decisions at once — one stands', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await p.setUp(`Works Decide Race ${i}`);
      const permitId = await approved(s);
      const asked = (await ask(s, permitId).expect(201)).body as InspectionBody;
      const both = await Promise.all([
        decide(s, asked.id, 'passed'),
        decide(s, asked.id, 'failed', ['other']),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const certificates = await p.v.inTx(s.c, (tx) =>
        tx.permitInspection.count({
          where: { permitId, certificateNumber: { not: null } },
        }),
      );
      expect(certificates).toBeLessThanOrEqual(1);
    }
  });

  it('race: two asks at once — one is open', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await p.setUp(`Works Ask Race ${i}`);
      const permitId = await approved(s);
      const both = await Promise.all([ask(s, permitId), ask(s, permitId)]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    }
  });
});
