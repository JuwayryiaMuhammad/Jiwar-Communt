import { ApiProperty } from '@nestjs/swagger';
import type { SuggestionTopic } from '@prisma/client';

/** A topic as whoever writes a suggestion sees it: only active ones are offered. */
export class SuggestionTopicOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;

  static from(t: SuggestionTopic): SuggestionTopicOptionView {
    return { id: t.id, key: t.key, nameAr: t.nameAr, nameEn: t.nameEn };
  }
}

/** A topic as the staff see it. */
export class SuggestionTopicView extends SuggestionTopicOptionView {
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(t: SuggestionTopic): SuggestionTopicView {
    return {
      ...SuggestionTopicOptionView.from(t),
      active: t.active,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}
