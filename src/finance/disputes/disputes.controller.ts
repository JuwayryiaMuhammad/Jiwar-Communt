import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { DisputesService } from './disputes.service';
import {
  DecideDisputeDto,
  OpenDisputeDto,
  StaffDisputesQueryDto,
} from './dto/disputes.dto';
import { DisputeView, StaffDisputeView } from './views/dispute.views';

/**
 * Invoice disputes, for the staff who keep the invoices (ADR 0048). Their
 * views carry the opener's words and a photo link: never stored.
 */
@ApiArea('finance')
@RequirePermissions('finance.invoice')
@Controller('staff/invoice-disputes')
export class StaffDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List invoice disputes, newest first' })
  @ApiOkResponse({ type: ListOf(StaffDisputeView) })
  async list(
    @Query() q: StaffDisputesQueryDto,
  ): Promise<ListResponse<StaffDisputeView>> {
    return toList(await this.disputes.list(q), (v) => v);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get an invoice dispute with its words and photo' })
  @ApiOkResponse({ type: StaffDisputeView })
  detail(@Param('id', parseId()) id: string): Promise<StaffDisputeView> {
    return this.disputes.detail(id);
  }

  @Post(':id/decide')
  @NoStore()
  @ApiOperation({
    summary: 'Accept a dispute with a credit note, or reject it with a reason',
    description:
      'Once. An acceptance credits at most what the invoice owes now; the opener is told.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: StaffDisputeView })
  decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideDisputeDto,
  ): Promise<StaffDisputeView> {
    return this.disputes.decide(id, dto);
  }
}

/**
 * Disputing a unit's invoice, for whoever sees its money (ADR 0048). The
 * opener's words and photo are theirs: other viewers read the code, the
 * status and the decision.
 */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class UnitDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post('invoices/:id/disputes')
  @NoStore()
  @ApiOperation({
    summary: 'Dispute one of my units’ invoices',
    description:
      'Something must be owed on it, and no other dispute be open. While open, the invoice is frozen: no reminder, and it cannot be paid by name.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: DisputeView })
  open(
    @Param('id', parseId()) id: string,
    @Body() dto: OpenDisputeDto,
  ): Promise<DisputeView> {
    return this.disputes.open(id, dto);
  }

  @Get('invoices/:id/disputes')
  @NoStore()
  @ApiOperation({ summary: 'List an invoice’s disputes, newest first' })
  @ApiOkResponse({ type: [DisputeView] })
  list(@Param('id', parseId()) id: string): Promise<DisputeView[]> {
    return this.disputes.forInvoice(id);
  }

  @Get('invoice-disputes/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get a dispute of one of my units’ invoices' })
  @ApiOkResponse({ type: DisputeView })
  detail(@Param('id', parseId()) id: string): Promise<DisputeView> {
    return this.disputes.mine(id);
  }
}
