import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import type { FormalNotice } from '@prisma/client';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import {
  FormalNotices,
  noticeNumber,
} from '../../core/formal-notices/formal-notices.service';
import { NoticeSettingsDto } from './dto/late-notices.dto';
import { LateNoticesService } from './late-notices.service';

export class NoticeSettingsView {
  @ApiProperty({ type: Number })
  lateNoticeCureDays: number;
}

/** One recipient's proofs (ADR 0058). */
export class NoticeRecipientView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  deliveredAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emailedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt: Date | null;
}

/** A late-payment notice and who got it, with each one's proofs. */
export class StaffLateNoticeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'FN-000012' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'uuid', description: 'The invoice.' })
  invoiceId: string;
  @ApiProperty({ type: String, description: 'EGP still owed at issue.' })
  amount: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt: Date;
  @ApiProperty({ type: [NoticeRecipientView] })
  recipients: NoticeRecipientView[];

  static from(
    n: FormalNotice & { recipients: NoticeRecipientView[] },
  ): StaffLateNoticeView {
    return {
      id: n.id,
      number: noticeNumber(n.number),
      unitId: n.unitId,
      invoiceId: n.subjectId,
      amount: n.amount.toFixed(2),
      dueOn: n.dueOn.toISOString().slice(0, 10),
      issuedAt: n.issuedAt,
      recipients: n.recipients.map((r) => ({
        accountId: r.accountId,
        deliveredAt: r.deliveredAt,
        emailedAt: r.emailedAt,
        readAt: r.readAt,
      })),
    };
  }
}

/** Formal late-payment notices (ADR 0058): the cure period and the record. */
@ApiArea('finance')
@RequirePermissions('finance.invoice')
@Controller('staff/finance')
export class LateNoticesController {
  constructor(
    private readonly late: LateNoticesService,
    private readonly notices: FormalNotices,
  ) {}

  @Get('notice-settings')
  @ApiOperation({ summary: 'Get the cure period before a late-payment notice' })
  @ApiOkResponse({ type: NoticeSettingsView })
  async settings(): Promise<NoticeSettingsView> {
    return { lateNoticeCureDays: await this.late.cureDays() };
  }

  @Patch('notice-settings')
  @ApiOperation({ summary: 'Set the cure period before a late-payment notice' })
  @ApiOkResponse({ type: NoticeSettingsView })
  async update(@Body() dto: NoticeSettingsDto): Promise<NoticeSettingsView> {
    return {
      lateNoticeCureDays: await this.late.setCureDays(dto.lateNoticeCureDays),
    };
  }

  @Get('late-notices')
  @ApiOperation({
    summary:
      'List the late-payment notices with their delivery and read proofs',
  })
  @ApiOkResponse({ type: ListOf(StaffLateNoticeView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<StaffLateNoticeView>> {
    return toList(await this.notices.forStaff('late_payment', q), (n) =>
      StaffLateNoticeView.from(n),
    );
  }
}
