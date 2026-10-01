import { ApiProperty } from '@nestjs/swagger';
import type { InboxItem } from '../notifications.service';

export class NotificationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, description: 'A catalog code (ADR 0027).' })
  kind: string;

  @ApiProperty({ enum: ['normal', 'critical'] })
  priority: 'normal' | 'critical';

  @ApiProperty({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    description: "The kind's params; the app renders the text.",
  })
  params: Record<string, string | number>;

  @ApiProperty({ type: String, nullable: true })
  targetType: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  targetId: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(n: InboxItem): NotificationView {
    return {
      id: n.id,
      kind: n.kind,
      priority: n.priority,
      params: n.params,
      targetType: n.targetType,
      targetId: n.targetId,
      readAt: n.readAt,
      createdAt: n.createdAt,
    };
  }
}

export class UnreadCountView {
  @ApiProperty({ type: Number })
  unread: number;

  @ApiProperty({ type: Number, description: 'Unread and critical.' })
  critical: number;
}

export class ReadAllView {
  @ApiProperty({ type: Number })
  read: number;
}
