import { ApiProperty } from '@nestjs/swagger';
import type { NeighbourComplaintNotice } from '@prisma/client';
import { ComplaintCategoryOptionView } from '../../categories/views/category.views';
import { isOpen } from '../complaint-rules';
import type { NoticeRead } from '../notices.service';

/** The answer to sending a notice. No body: a stored replay holds no text. */
export class NoticeSentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  sentAt: Date;

  static from(
    n: Pick<NeighbourComplaintNotice, 'id' | 'createdAt'>,
  ): NoticeSentView {
    return { id: n.id, sentAt: n.createdAt };
  }
}

/**
 * A notice as the unit it was sent to reads it (ADR 0042): what it is
 * about, in the compound's own category, and the management's words. It
 * has no field for the complaint: no number, no filing date, no text, no
 * evidence, nobody's name.
 */
export class UnitNoticeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: ComplaintCategoryOptionView })
  category: ComplaintCategoryOptionView;
  @ApiProperty({
    type: String,
    description: 'The caller’s unit it was sent to.',
  })
  unitCode: string;
  @ApiProperty({ type: String, description: 'Written by the management.' })
  body: string;
  @ApiProperty({
    type: Boolean,
    description: 'The matter is still open: the unit may answer.',
  })
  open: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  sentAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Withdrawn by an overturned appeal (ADR 0059): it no longer stands against the unit.',
  })
  withdrawnAt: Date | null;

  static from(r: NoticeRead): UnitNoticeView {
    return {
      id: r.notice.id,
      category: ComplaintCategoryOptionView.from(r.category),
      unitCode: r.unit.code,
      body: r.notice.body,
      open: isOpen(r.status),
      sentAt: r.notice.createdAt,
      withdrawnAt: r.notice.withdrawnAt,
    };
  }
}
