import { AppException } from './errors';
import { keysetCursor } from './cursor';

const ID_A = '01920000-0000-7000-8000-00000000000a';
const ID_B = '01920000-0000-7000-8000-00000000000b';
const AT = new Date('2026-09-30T10:00:00.000Z');

describe('keysetCursor', () => {
  it('pages newest first by default', () => {
    const c = keysetCursor('createdAt');
    const cursor = c.encode({ createdAt: AT, id: ID_A });
    expect(c.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(c.after(cursor)).toEqual([
      {
        OR: [{ createdAt: { lt: AT } }, { createdAt: AT, id: { lt: ID_A } }],
      },
    ]);
  });

  it('pages oldest first with asc, with the same cursor format', () => {
    const desc = keysetCursor('createdAt');
    const asc = keysetCursor('createdAt', 'asc');
    const row = { createdAt: AT, id: ID_A };
    expect(asc.encode(row)).toBe(desc.encode(row));
    expect(asc.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(asc.after(asc.encode(row))).toEqual([
      {
        OR: [{ createdAt: { gt: AT } }, { createdAt: AT, id: { gt: ID_A } }],
      },
    ]);
  });

  it('returns a next cursor only when a further row was fetched', () => {
    const c = keysetCursor('createdAt', 'asc');
    const rows = [
      { createdAt: AT, id: ID_A },
      { createdAt: AT, id: ID_B },
    ];
    expect(c.toPage(rows, 2).nextCursor).toBeNull();
    const page = c.toPage(rows, 1);
    expect(page.items).toEqual([rows[0]]);
    expect(c.decode(page.nextCursor!)).toEqual({ at: AT, id: ID_A });
  });

  it('rejects a malformed cursor as INVALID_FORMAT on cursor', () => {
    const c = keysetCursor('createdAt');
    try {
      c.after('not-a-cursor');
      throw new Error('expected a failure');
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      expect((e as AppException).getResponse()).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [{ field: 'cursor', code: 'INVALID_FORMAT' }],
      });
    }
  });
});
