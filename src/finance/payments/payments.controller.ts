import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  RecordOfficePaymentDto,
  ReversePaymentDto,
  StaffPaymentsQueryDto,
} from './dto/payments.dto';
import { PaymentsService } from './payments.service';
import {
  PaymentDetailView,
  PaymentView,
  StatementView,
} from './views/payment.views';

/** Payments at the office and online, for the staff who keep them (ADR 0046). */
@ApiArea('finance')
@Controller('staff')
export class StaffPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments')
  @RequirePermissions('finance.payments')
  @ApiOperation({ summary: 'List payments, newest first' })
  @ApiOkResponse({ type: ListOf(PaymentView) })
  async list(
    @Query() q: StaffPaymentsQueryDto,
  ): Promise<ListResponse<PaymentView>> {
    return toList(await this.payments.list(q), (v) => v);
  }

  @Get('payments/:id')
  @RequirePermissions('finance.payments')
  @ApiOperation({ summary: 'Get a payment, its receipt and what it paid' })
  @ApiOkResponse({ type: PaymentDetailView })
  detail(@Param('id', parseId()) id: string): Promise<PaymentDetailView> {
    return this.payments.detail(id);
  }

  @Post('units/:unitId/payments')
  @RequirePermissions('finance.payments')
  @ApiOperation({
    summary: 'Record a payment made at the office',
    description:
      'Cash, a bank transfer or a cheque; at most what is owed. It pays the invoices named first, then the oldest due.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: PaymentDetailView })
  record(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: RecordOfficePaymentDto,
  ): Promise<PaymentDetailView> {
    return this.payments.recordOffice(unitId, dto);
  }

  @Post('payments/:id/reverse')
  @RequirePermissions('finance.payments')
  @ApiOperation({
    summary: 'Reverse an office payment, once, with a reason code',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: PaymentDetailView })
  reverse(
    @Param('id', parseId()) id: string,
    @Body() dto: ReversePaymentDto,
  ): Promise<PaymentDetailView> {
    return this.payments.reverse(id, dto);
  }

  @Get('units/:unitId/statement')
  @RequireAnyPermission('finance.invoice', 'finance.payments')
  @ApiOperation({
    summary: 'Where a unit stands: owed, credit, latest activity',
  })
  @ApiOkResponse({ type: StatementView })
  statement(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<StatementView> {
    return this.payments.statement(unitId, true);
  }
}

/** A unit's payments and statement, for whoever sees its money (ADR 0046). */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class UnitPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('units/:unitId/payments')
  @ApiOperation({ summary: 'List a unit’s payments, newest first' })
  @ApiOkResponse({ type: ListOf(PaymentView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PaymentView>> {
    return toList(await this.payments.forUnit(unitId, q), (v) => v);
  }

  @Get('payments/:id')
  @ApiOperation({ summary: 'Get one of my units’ payments and its receipt' })
  @ApiOkResponse({ type: PaymentDetailView })
  detail(@Param('id', parseId()) id: string): Promise<PaymentDetailView> {
    return this.payments.mine(id);
  }

  @Get('units/:unitId/statement')
  @ApiOperation({
    summary: 'Where my unit stands: owed, credit, latest activity',
  })
  @ApiOkResponse({ type: StatementView })
  statement(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<StatementView> {
    return this.payments.statement(unitId, false);
  }
}
