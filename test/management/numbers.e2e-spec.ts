import { RequestsService } from '../../src/management/requests/requests.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers } from '../setup/management';

/**
 * ADR 0039: a request's number comes from the compound's counter, taken by
 * an upsert whose row lock lasts until the creating transaction ends (as a
 * ticket's, ADR 0032). Under concurrent creation every number is distinct,
 * none is skipped, and each compound counts on its own.
 */
describe('Management requests — numbers', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
  });

  afterAll(() => h.close());

  it('20 parallel creations get the numbers 1 to 20, per compound', async () => {
    const requests = h.moduleRef.get(RequestsService);
    const setUp = async () => {
      const c = await m.x.compound();
      const unit = await m.x.unit(c);
      const residents = await Promise.all(
        [0, 1, 2, 3].map(() => m.x.resident(c, [unit.id])),
      );
      return { c, residents, topicId: await m.topicId(c) };
    };
    const [one, two] = await Promise.all([setUp(), setUp()]);
    const burst = (s: Awaited<ReturnType<typeof setUp>>) =>
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          m.x.as(s.c, { id: s.residents[i % 4].id, type: 'resident' }, () =>
            requests.create({
              type: 'question',
              topicId: s.topicId,
              body: `Burst ${i}`,
            }),
          ),
        ),
      );
    const [a, b] = await Promise.all([burst(one), burst(two)]);
    const expected = Array.from({ length: 20 }, (_, i) => i + 1);
    for (const [s, created] of [
      [one, a],
      [two, b],
    ] as const) {
      // Distinct and without a gap: nothing rolled back, so nothing skipped.
      expect(created.map((r) => r.number).sort((p, q) => p - q)).toEqual(
        expected,
      );
      const counter = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequestCounter.findUniqueOrThrow({
          where: { tenantId: s.c.tenantId },
        }),
      );
      expect(counter.lastNumber).toBe(20);
      // One first message each, in the request's own compound.
      const messages = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequestMessage.count(),
      );
      expect(messages).toBe(20);
    }
  });

  it('a refused creation takes no number', async () => {
    const requests = h.moduleRef.get(RequestsService);
    const c = await m.x.compound();
    const unit = await m.x.unit(c);
    const resident = await m.x.resident(c, [unit.id]);
    const topicId = await m.topicId(c);
    const as = <T>(fn: () => Promise<T>) =>
      m.x.as(c, { id: resident.id, type: 'resident' }, fn);
    const first = await as(() =>
      requests.create({ type: 'general', topicId, body: 'One' }),
    );
    // Empty once trimmed: refused inside the transaction, which rolls back.
    await expect(
      as(() => requests.create({ type: 'general', topicId, body: '   ' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const second = await as(() =>
      requests.create({ type: 'general', topicId, body: 'Two' }),
    );
    expect([first.number, second.number]).toEqual([1, 2]);
  });
});
