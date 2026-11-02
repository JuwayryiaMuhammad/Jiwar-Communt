import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { accountRef, AccountRefView } from '../../core/common/http/personal';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { SensitivityService } from './sensitivity.service';

export class SetSensitivityDto {
  @ApiProperty({
    type: Boolean,
    description:
      '`true` marks the ticket sensitive (`tickets.dispatch`); `false` clears it (`tickets.sensitive`).',
  })
  @IsBoolean()
  sensitive: boolean;

  @ApiProperty({
    type: String,
    description:
      'From `ticketSensitive` to mark, `ticketSensitiveClear` to clear; see `allowed` on INVALID_REASON_CODE.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class SensitiveReadView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: AccountRefView,
    description: 'The staff member who read it.',
  })
  reader: AccountRefView;
  @ApiProperty({
    enum: ['detail', 'list', 'export', 'search'],
    enumName: 'SensitiveReadVia',
    description:
      'How: its page or a part of it (a write reads it too), a list page, the export, the search.',
  })
  via: string;
  @ApiProperty({ type: String, format: 'date-time' })
  readAt: Date;
}

/**
 * Sensitive tickets (ADR 0081): marked by the dispatch, cleared and
 * audited by the holders of `tickets.sensitive`, who alone read the log of
 * every staff read of one.
 */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/tickets')
export class SensitivityController {
  constructor(private readonly sensitivity: SensitivityService) {}

  /**
   * Marks or clears; audited with the reason code. A ticket already as
   * asked is left as it is (204, no entry).
   */
  @Put(':id/sensitivity')
  @ApiOperation({ summary: 'Mark a ticket sensitive, or clear it' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  set(
    @Param('id', parseId()) id: string,
    @Body() dto: SetSensitivityDto,
  ): Promise<void> {
    return this.sensitivity.set(id, dto.sensitive, dto.reasonCode);
  }

  /** Every staff read of the ticket, newest first. */
  @Get(':id/sensitive-reads')
  @RequirePermissions('tickets.dispatch', 'tickets.sensitive')
  @ApiOperation({ summary: 'Who read a sensitive ticket' })
  @ApiOkResponse({ type: ListOf(SensitiveReadView) })
  async reads(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<SensitiveReadView>> {
    const page = await this.sensitivity.reads(id, q);
    return toList(page, (r) => ({
      id: r.id,
      reader: accountRef(
        page.people.get(r.accountId) ?? {
          id: r.accountId,
          fullName: null,
          status: 'erased',
        },
      ),
      via: r.via,
      readAt: r.readAt,
    }));
  }
}
