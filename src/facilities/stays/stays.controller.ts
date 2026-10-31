import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BookingView } from '../bookings/views/booking.views';
import { CreateStayDto } from './dto/stays.dto';
import { StaysService } from './stays.service';

/** Overnight guest rooms (ADR 0070): booked by the night. */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller('units/:unitId/stays')
export class StaysController {
  constructor(
    private readonly stays: StaysService,
    private readonly ctx: RequestContext,
  ) {}

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Book nights in a guest room',
    description:
      'Confirmed at once, from the check-in on the first night to the check-out on `toOn`, in the compound’s time zone. Each night needs a free room (STAY_NIGHT_FULL); a stay counts as one booking of the weekly quota. Cancelled, read and listed as any booking.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: BookingView })
  async book(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateStayDto,
  ): Promise<BookingView> {
    return BookingView.from(
      await this.stays.book(unitId, dto),
      this.ctx.accountId,
    );
  }
}
