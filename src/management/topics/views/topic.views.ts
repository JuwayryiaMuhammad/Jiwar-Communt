import { ApiProperty } from '@nestjs/swagger';
import type { TopicRead } from '../topics.service';

/** The role that owns a topic: its key (a default role's) and its name. */
export class TopicOwnerView {
  @ApiProperty({ type: String, description: 'The role’s key.' })
  roleKey: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Written by the compound; a default role has none (name it by key).',
  })
  roleName: string | null;
}

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
  @ApiProperty({
    type: TopicOwnerView,
    nullable: true,
    description:
      'Who answers it (ADR 0058): a role, never a person; null when any handler does.',
  })
  owner: TopicOwnerView | null;

  static from(t: TopicRead): TopicOptionView {
    return {
      id: t.id,
      key: t.key,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      targetResponseHours: t.targetResponseHours,
      owner: t.ownerRole
        ? { roleKey: t.ownerRole.key, roleName: t.ownerRole.name }
        : null,
    };
  }
}

/** A topic as the manager sees it. */
export class TopicView extends TopicOptionView {
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  ownerRoleId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(t: TopicRead): TopicView {
    return {
      ...TopicOptionView.from(t),
      active: t.active,
      ownerRoleId: t.ownerRoleId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}
