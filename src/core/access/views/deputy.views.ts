import { ApiProperty } from '@nestjs/swagger';
import type { DeputyRead } from '../deputies.service';

/** A deputyship as either of its accounts reads it (ADR 0073). */
export class DeputyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  principalAccountId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  deputyAccountId: string;
  @ApiProperty({ type: [String] })
  permissions: string[];
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    enum: ['ended', 'expired', 'account_left'],
    nullable: true,
    description:
      '`ended`: by one of its accounts; `expired`: its time ran out; `account_left`: one of them is no longer active.',
  })
  endReason: string | null;
  @ApiProperty({ type: Boolean, description: 'In force now.' })
  live: boolean;
  @ApiProperty({
    enum: ['principal', 'deputy'],
    description: 'The caller’s side of it.',
  })
  role: 'principal' | 'deputy';

  static from(d: DeputyRead): DeputyView {
    return Object.assign(new DeputyView(), {
      ...d,
      permissions: [...d.permissions],
    });
  }
}
