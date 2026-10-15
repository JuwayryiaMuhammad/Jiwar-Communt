import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { RecordFinePaymentDto, ReverseFinePaymentDto } from './dto/fines.dto';
import { FinePaymentsService } from './fine-payments.service';
import { FinePaymentView } from './views/fine.views';

/** A fine's payments at the office, for the accountant (ADR 0045). */
@ApiArea('fines')
@RequirePermissions('fines.billing')
@Controller('staff')
export class FinePaymentsController {
  constructor(private readonly payments: FinePaymentsService) {}

  @Post('vehicle-fines/:id/payments')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Record a fine’s payment made at the office',
    description:
      'The whole amount (AMOUNT_MISMATCH) of an unpaid fine (FINE_NOT_PAYABLE) not under appeal (FINE_UNDER_APPEAL); the fine is then paid.',
  })
  @ApiCreatedResponse({ type: FinePaymentView })
  async record(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordFinePaymentDto,
  ): Promise<FinePaymentView> {
    return FinePaymentView.from(await this.payments.record(id, dto));
  }

  @Post('vehicle-fine-payments/:id/reverse')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Reverse a payment recorded by mistake, with a reason code',
    description:
      'Once (FINE_PAYMENT_ALREADY_REVERSED); the fine is unpaid again.',
  })
  @ApiCreatedResponse({ type: FinePaymentView })
  async reverse(
    @Param('id', parseId()) id: string,
    @Body() dto: ReverseFinePaymentDto,
  ): Promise<FinePaymentView> {
    return FinePaymentView.from(
      await this.payments.reverse(id, dto.reasonCode),
    );
  }
}
