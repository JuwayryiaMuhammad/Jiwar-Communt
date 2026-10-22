import { ApiProperty } from '@nestjs/swagger';
import {
  FORMAL_NOTICE_TYPES,
  noticeNumber,
  type MyNotice,
} from './formal-notices.service';

/** A formal notice as its recipient reads it, with their own proofs. */
export class MyNoticeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'FN-000012' })
  number: string;
  @ApiProperty({ enum: FORMAL_NOTICE_TYPES, enumName: 'FormalNoticeType' })
  type: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ enum: ['invoice'], description: 'What it is about.' })
  subjectType: string;
  @ApiProperty({ type: String, format: 'uuid' })
  subjectId: string;
  @ApiProperty({
    type: String,
    description: 'EGP: what was still owed when it was issued.',
  })
  amount: string;
  @ApiProperty({ type: String, format: 'date', description: 'Local day.' })
  dueOn: string;
  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  deliveredAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When its email was sent; null while it was not.',
  })
  emailedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'The first opening (`GET /me/notices/{id}`).',
  })
  readAt: Date | null;

  static from(m: MyNotice): MyNoticeView {
    const n = m.notice;
    return {
      id: n.id,
      number: noticeNumber(n.number),
      type: n.type,
      unitId: n.unitId,
      subjectType: n.subjectType,
      subjectId: n.subjectId,
      amount: n.amount.toFixed(2),
      dueOn: n.dueOn.toISOString().slice(0, 10),
      issuedAt: n.issuedAt,
      deliveredAt: m.deliveredAt,
      emailedAt: m.emailedAt,
      readAt: m.readAt,
    };
  }
}
