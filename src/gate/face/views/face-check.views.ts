import { ApiProperty } from '@nestjs/swagger';
import { GuardBlocklistEntryView } from '../../blocklist/views/blocklist.views';
import type { FaceCheckRead } from '../face-checks.service';

/**
 * A face check as the guard reads it (ADR 0068): advisory only. The
 * entries it may be, as an ID lookup shows them — never the vendor's
 * score, never a refusal by itself.
 */
export class FaceCheckView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: ['pending', 'no_match', 'possible_match', 'unavailable'],
    enumName: 'FaceCheckOutcome',
    description:
      '`possible_match`: compare the face yourself; `unavailable`: the vendor did not answer — go on by hand; `pending`: not answered (the shift ended before).',
  })
  outcome: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  checkedAt: Date | null;
  @ApiProperty({
    type: [GuardBlocklistEntryView],
    description: 'The live entries the face may be: kind, name and face.',
  })
  matches: GuardBlocklistEntryView[];

  static from(r: FaceCheckRead): FaceCheckView {
    return {
      id: r.check.id,
      outcome: r.outcome,
      checkedAt: r.check.checkedAt,
      matches: r.matches.map((m) => GuardBlocklistEntryView.from(m)),
    };
  }
}
