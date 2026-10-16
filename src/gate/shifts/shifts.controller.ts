import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
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
import { EndShiftDto, StartShiftDto } from './dto/shifts.dto';
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
  @ApiOperation({ summary: 'List the gates a shift can start at' })
  @ApiOkResponse({ type: ListOf(GuardGateView) })
  async gatesList(): Promise<ListResponse<GuardGateView>> {
    return bounded(await this.gates.active(), (g) => GuardGateView.from(g));
  }

  @Post('shifts/start')
  @ApiOperation({
    summary: 'Start my shift at a gate or in a zone',
    description:
      'Exactly one of `gateId` and `zoneId`. In a zone, the gate actions answer 403 SHIFT_NOT_AT_GATE.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: ShiftView })
  async start(@Body() dto: StartShiftDto): Promise<ShiftView> {
    return ShiftView.from(await this.shifts.start(dto));
  }

  @Post('shifts/end')
  @ApiOperation({
    summary: 'End my shift, handing over',
    description:
      'Every active item of the compound’s handover checklist ticked (422 HANDOVER_CHECKLIST_INCOMPLETE), and notes if any. The next guard at the post acknowledges the handover.',
  })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOkResponse({ type: ShiftView })
  async end(@Body() dto: EndShiftDto): Promise<ShiftView> {
    return ShiftView.from(await this.shifts.end(dto));
  }

  @Get('shifts/current')
  @ApiOperation({ summary: 'Get my current shift' })
  @ApiOkResponse({ type: ShiftView })
  async current(): Promise<ShiftView> {
    return ShiftView.from(await this.shifts.current());
  }
}
