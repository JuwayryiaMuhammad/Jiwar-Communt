import { ApiProperty } from '@nestjs/swagger';
import type { ManagementRequestTopic } from '@prisma/client';

/** A topic as whoever opens a request sees it: only active ones are offered. */
export class TopicOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;
  @ApiProperty({
    type: Number,
    description: 'Hours the management gives itself to answer.',
  })
  targetResponseHours: number;

  static from(t: ManagementRequestTopic): TopicOptionView {
    return {
      id: t.id,
      key: t.key,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      targetResponseHours: t.targetResponseHours,
    };
  }
}

/** A topic as the manager sees it. */
export class TopicView extends TopicOptionView {
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(t: ManagementRequestTopic): TopicView {
    return {
      ...TopicOptionView.from(t),
      active: t.active,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}
