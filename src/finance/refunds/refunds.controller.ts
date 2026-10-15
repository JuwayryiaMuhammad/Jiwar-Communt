import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  RecordRefundDto,
  RefundsQueryDto,
  ReverseRefundDto,
} from './dto/refunds.dto';
import { RefundsService } from './refunds.service';
import { RefundView } from './views/refund.views';

/** Refunds of a unit's credit, the manager's alone (ADR 0048). */
@ApiArea('finance')
@RequirePermissions('finance.refund')
@Controller('staff')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post('units/:unitId/refunds')
  @ApiOperation({
    summary: 'Refund part or all of a unit’s credit (step-up required)',
    description:
      'Recorded by hand: no call to the payment provider. At most the unit’s credit now; spends the session’s step-up.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: RefundView })
  record(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: RecordRefundDto,
  ): Promise<RefundView> {
    return this.refunds.record(unitId, dto);
  }

  @Post('refunds/:id/reverse')
  @ApiOperation({
    summary: 'Reverse a refund: the money is the unit’s credit again',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: RefundView })
  reverse(
    @Param('id', parseId()) id: string,
    @Body() dto: ReverseRefundDto,
  ): Promise<RefundView> {
    return this.refunds.reverse(id, dto);
  }

  @Get('refunds')
  @ApiOperation({ summary: 'List refunds, newest first' })
  @ApiOkResponse({ type: ListOf(RefundView) })
  async list(@Query() q: RefundsQueryDto): Promise<ListResponse<RefundView>> {
    return toList(await this.refunds.list(q), (v) => v);
  }

  @Get('refunds/:id')
  @ApiOperation({ summary: 'Get a refund with the payments it took from' })
  @ApiOkResponse({ type: RefundView })
  detail(@Param('id', parseId()) id: string): Promise<RefundView> {
    return this.refunds.detail(id);
  }
}
