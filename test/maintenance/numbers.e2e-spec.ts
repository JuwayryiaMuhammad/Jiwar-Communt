import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { communityHelpers } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0032: a ticket's number comes from the compound's counter, taken by
 * an upsert whose row lock lasts until the creating transaction ends. Under
 * concurrent creation every number is distinct and they only grow; gaps
 * are tolerated (a later sequence may skip numbers), duplicates never.
 */
describe('Maintenance — ticket numbers', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
  });

  afterAll(() => h.close());

  it('20 parallel creations get 20 distinct numbers, per compound', async () => {
    const tickets = h.moduleRef.get(TicketsService);
    const setUp = async () => {
      const c = await x.compound();
      const unit = await x.unit(c);
      const residents = await Promise.all(
        [0, 1, 2, 3].map(() => x.resident(c, [unit.id])),
      );
      const category = await x.asManager(c, () =>
        x.prisma.tenant.ticketCategory.findFirstOrThrow({
          where: { key: 'general' },
        }),
      );
      return { c, unit, residents, category };
    };
    const [one, two] = await Promise.all([setUp(), setUp()]);
    const burst = (s: Awaited<ReturnType<typeof setUp>>) =>
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          x.as(s.c, { id: s.residents[i % 4].id, type: 'resident' }, () =>
            tickets.create({
              unitId: s.unit.id,
              categoryId: s.category.id,
              description: `Burst ${i}`,
            }),
          ),
        ),
      );
    const [a, b] = await Promise.all([burst(one), burst(two)]);
    for (const created of [a, b]) {
      const numbers = created.map((t) => t.number).sort((p, q) => p - q);
      expect(new Set(numbers).size).toBe(20);
      expect(numbers[0]).toBeGreaterThanOrEqual(1);
    }
    // Each compound counts on its own.
    expect(Math.min(...a.map((t) => t.number))).toBe(1);
    expect(Math.min(...b.map((t) => t.number))).toBe(1);
    const counter = await x.asManager(one.c, () =>
      x.prisma.tenant.ticketCounter.findUniqueOrThrow({
        where: { tenantId: one.c.tenantId },
      }),
    );
    expect(counter.lastNumber).toBeGreaterThanOrEqual(
      Math.max(...a.map((t) => t.number)),
    );
  });
});
