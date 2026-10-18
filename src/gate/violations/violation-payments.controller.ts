import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  RecordViolationPaymentDto,
  ReverseViolationPaymentDto,
} from './dto/violations.dto';
import { ViolationPaymentsService } from './violation-payments.service';
import { StaffViolationView } from './views/violation.views';

/** A violation's payment at the office (ADR 0053), as a fine's. */
@ApiArea('violations')
@RequirePermissions('fines.billing')
@Controller('staff')
export class ViolationPaymentsController {
  constructor(private readonly payments: ViolationPaymentsService) {}

  @Post('violations/:id/payments')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Record a violation’s payment at the office',
    description:
      'The whole amount, a receipt number (once among the compound’s violation payments) and the local day. A warning, a paid or a cancelled one: VIOLATION_NOT_PAYABLE; under appeal: VIOLATION_UNDER_APPEAL.',
  })
  @ApiCreatedResponse({ type: StaffViolationView })
  async record(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordViolationPaymentDto,
  ): Promise<StaffViolationView> {
    return StaffViolationView.from(
      await this.payments.record(id, {
        ...dto,
        paidOn: dto.paidOn,
      }),
    );
  }

  @Post('violation-payments/:id/reverse')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Reverse a violation’s payment, once',
    description:
      'With a code from `violationPaymentReverse`: the violation is open again. Reversed already: VIOLATION_PAYMENT_ALREADY_REVERSED.',
  })
  @ApiCreatedResponse({ type: StaffViolationView })
  async reverse(
    @Param('id', parseId()) id: string,
    @Body() dto: ReverseViolationPaymentDto,
  ): Promise<StaffViolationView> {
    return StaffViolationView.from(
      await this.payments.reverse(id, dto.reasonCode),
    );
  }
}
