import {
  isAhead,
  isOut,
  isPinned,
  statusOf,
  worksActive,
} from './announcement-rules';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const row = (over: object = {}) => ({
  publishAt: null,
  expiresAt: null,
  archivedAt: null,
  worksStartsAt: null,
  worksEndsAt: null,
  priority: 'normal' as const,
  pinnedUntil: null,
  ...over,
});

describe('announcement rules (ADR 0040)', () => {
  it('draft, scheduled, published, expired, ended, archived: by the dates alone', () => {
    expect(statusOf(row(), NOW)).toBe('draft');
    expect(statusOf(row({ publishAt: at(1) }), NOW)).toBe('scheduled');
    expect(statusOf(row({ publishAt: at(-1) }), NOW)).toBe('published');
    // The very instant it is due, it is out.
    expect(statusOf(row({ publishAt: NOW }), NOW)).toBe('published');
    expect(statusOf(row({ publishAt: at(-2), expiresAt: at(-1) }), NOW)).toBe(
      'expired',
    );
    expect(statusOf(row({ publishAt: at(-2), expiresAt: NOW }), NOW)).toBe(
      'expired',
    );
    expect(
      statusOf(
        row({ publishAt: at(-3), worksStartsAt: at(-2), worksEndsAt: at(-1) }),
        NOW,
      ),
    ).toBe('ended');
    // Archived wins over everything.
    expect(
      statusOf(row({ publishAt: at(-1), archivedAt: at(-0.5) }), NOW),
    ).toBe('archived');
    expect(statusOf(row({ archivedAt: at(-1) }), NOW)).toBe('archived');
  });

  it('isOut is published only; isAhead is draft or scheduled', () => {
    expect(isOut(row({ publishAt: at(-1) }), NOW)).toBe(true);
    expect(isOut(row({ publishAt: at(1) }), NOW)).toBe(false);
    expect(isAhead(row(), NOW)).toBe(true);
    expect(isAhead(row({ publishAt: at(1) }), NOW)).toBe(true);
    expect(isAhead(row({ publishAt: at(-1) }), NOW)).toBe(false);
    expect(isAhead(row({ archivedAt: at(-1) }), NOW)).toBe(false);
  });

  it('a pin holds while the announcement is out, important, and its date ahead', () => {
    const pinned = row({
      publishAt: at(-1),
      priority: 'important',
      pinnedUntil: at(1),
    });
    expect(isPinned(pinned, NOW)).toBe(true);
    expect(isPinned({ ...pinned, pinnedUntil: NOW }, NOW)).toBe(false);
    expect(isPinned({ ...pinned, pinnedUntil: null }, NOW)).toBe(false);
    expect(isPinned({ ...pinned, publishAt: at(1) }, NOW)).toBe(false);
    expect(isPinned({ ...pinned, archivedAt: at(-0.5) }, NOW)).toBe(false);
    expect(isPinned({ ...pinned, expiresAt: at(-0.5) }, NOW)).toBe(false);
  });

  it('works are under way from their start to their end, and stop by themselves', () => {
    const works = row({
      publishAt: at(-5),
      worksStartsAt: at(-1),
      worksEndsAt: at(1),
    });
    expect(worksActive(works, NOW)).toBe(true);
    expect(worksActive({ ...works, worksStartsAt: at(0.5) }, NOW)).toBe(false);
    expect(worksActive({ ...works, worksEndsAt: NOW }, NOW)).toBe(false);
    expect(worksActive({ ...works, publishAt: at(1) }, NOW)).toBe(false);
    expect(worksActive(row({ publishAt: at(-1) }), NOW)).toBe(false);
  });
});
