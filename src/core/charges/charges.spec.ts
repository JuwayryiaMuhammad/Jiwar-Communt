import { Prisma } from '@prisma/client';
import { Charges, type ChargesImpl } from './charges';

const impl: ChargesImpl = {
  lockUnit: () => Promise.resolve(),
  raise: () =>
    Promise.resolve({
      id: 'c',
      invoiceId: 'i',
      amount: new Prisma.Decimal('10.00'),
      status: 'open',
    }),
  cancel: () => Promise.resolve(null),
  of: () => Promise.resolve(new Map()),
};

describe('Charges (ADR 0070)', () => {
  it('is implemented once, and refuses use before', async () => {
    const c = new Charges();
    expect(() => c.lockUnit({} as never, 'u')).toThrow(/not implemented/);
    c.implement(impl);
    expect(() => c.implement(impl)).toThrow(/twice/);
    await expect(c.lockUnit({} as never, 'u')).resolves.toBeUndefined();
  });

  it('takes one paid handler per source', () => {
    const c = new Charges();
    const handler = () => Promise.resolve();
    c.registerPaidHandler('vehicle_fine', handler);
    expect(() => c.registerPaidHandler('vehicle_fine', handler)).toThrow(
      /twice/,
    );
    expect(c.paidHandler('vehicle_fine')).toBe(handler);
    expect(c.paidHandler('booking')).toBeNull();
  });

  it('answers no charges for no sources without asking finance', async () => {
    const c = new Charges();
    await expect(c.of({} as never, 'booking', [])).resolves.toEqual(new Map());
  });
});
