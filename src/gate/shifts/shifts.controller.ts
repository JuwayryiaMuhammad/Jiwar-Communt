import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { GatesService } from '../gates/gates.service';
import { GuardGateView } from '../gates/views/gate.views';
import { StartShiftDto } from './dto/shifts.dto';
import { ShiftsService } from './shifts.service';
import { ShiftView } from './views/shift.views';

/** The guard's shift (ADR 0028): `gate.operate`. */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate')
export class ShiftsController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly gates: GatesService,
  ) {}

  /** The active gates a shift can start at. */
  @Get('gates')
  @ApiOkResponse({ type: ListOf(GuardGateView) })
  async gatesList(): Promise<ListResponse<GuardGateView>> {
    return bounded(await this.gates.active(), (g) => GuardGateView.from(g));
  }

  @Post('shifts/start')
  @Idempotent()
  @ApiCreatedResponse({ type: ShiftView })
  async start(@Body() dto: StartShiftDto): Promise<ShiftView> {
    return ShiftView.from(await this.shifts.start(dto.gateId));
  }

  @Post('shifts/end')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOkResponse({ type: ShiftView })
  async end(): Promise<ShiftView> {
    return ShiftView.from(await this.shifts.end());
  }

  @Get('shifts/current')
  @ApiOkResponse({ type: ShiftView })
  async current(): Promise<ShiftView> {
    return ShiftView.from(await this.shifts.current());
  }
}
