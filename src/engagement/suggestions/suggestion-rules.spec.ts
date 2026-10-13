import { SuggestionStatus } from '@prisma/client';
import { canMove, needsResponse, nextStatuses } from './suggestion-rules';

describe('suggestion rules (ADR 0040)', () => {
  it('a suggestion only moves forward, and may be declined until it ends', () => {
    expect(nextStatuses('received')).toEqual([
      'under_review',
      'planned',
      'done',
      'declined',
    ]);
    expect(nextStatuses('under_review')).toEqual([
      'planned',
      'done',
      'declined',
    ]);
    expect(nextStatuses('planned')).toEqual(['done', 'declined']);
    expect(canMove('planned', 'under_review')).toBe(false);
    expect(canMove('under_review', 'received')).toBe(false);
  });

  it('done and declined are final, and nothing moves to where it is', () => {
    for (const end of ['done', 'declined'] as const)
      expect(nextStatuses(end)).toEqual([]);
    for (const status of Object.values(SuggestionStatus))
      expect(canMove(status, status)).toBe(false);
  });

  it('only a decline must be answered', () => {
    expect(
      Object.values(SuggestionStatus).filter((s) => needsResponse(s)),
    ).toEqual(['declined']);
  });
});
