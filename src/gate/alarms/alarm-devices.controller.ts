import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
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
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { AlarmDevicesService } from './alarm-devices.service';
import {
  AlarmDeviceQueryDto,
  PairAlarmDeviceDto,
  RegisterAlarmDeviceDto,
  RenameAlarmDeviceDto,
  RetireAlarmDeviceDto,
} from './dto/alarm-devices.dto';
import {
  AlarmDeviceView,
  PairedAlarmDeviceView,
} from './views/alarm-device.views';

/** The guard-down wearables, as the management keeps them (ADR 0068). */
@ApiArea('gate-devices')
@RequirePermissions('gate_devices.manage')
@Controller('staff/gate/alarm-devices')
export class StaffAlarmDevicesController {
  constructor(private readonly devices: AlarmDevicesService) {}

  @Post()
  @ApiOperation({
    summary: 'Register a guard-down wearable',
    description:
      'By the vendor’s own id: one live device each (409 DUPLICATE_RESOURCE on `deviceRef`).',
  })
  @ApiCreatedResponse({ type: AlarmDeviceView })
  async register(
    @Body() dto: RegisterAlarmDeviceDto,
  ): Promise<AlarmDeviceView> {
    return AlarmDeviceView.from(await this.devices.register(dto));
  }

  @Get()
  @ApiOperation({ summary: 'The wearables, and who wears each on shift' })
  @ApiOkResponse({ type: ListOf(AlarmDeviceView) })
  async list(
    @Query() q: AlarmDeviceQueryDto,
  ): Promise<ListResponse<AlarmDeviceView>> {
    return bounded(await this.devices.list(q.status), (r) =>
      AlarmDeviceView.from(r),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a wearable' })
  @ApiOkResponse({ type: AlarmDeviceView })
  async rename(
    @Param('id', parseId()) id: string,
    @Body() dto: RenameAlarmDeviceDto,
  ): Promise<AlarmDeviceView> {
    return AlarmDeviceView.from(await this.devices.rename(id, dto.label));
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire a wearable',
    description:
      'Once, with an `alarmDeviceRetire` code; its pairing ends. An alarm from it then reaches the control room only.',
  })
  @ApiOkResponse({ type: AlarmDeviceView })
  async retire(
    @Param('id', parseId()) id: string,
    @Body() dto: RetireAlarmDeviceDto,
  ): Promise<AlarmDeviceView> {
    return AlarmDeviceView.from(await this.devices.retire(id, dto.reasonCode));
  }
}

/** The wearable a guard on shift pairs (ADR 0068). */
@ApiArea('gate-devices')
@RequirePermissions('gate.operate')
@Controller('gate/alarm-devices')
export class GateAlarmDevicesController {
  constructor(private readonly devices: AlarmDevicesService) {}

  @Post('pair')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pair a wearable for this shift',
    description:
      'On shift, at a gate or in a zone. Ends what the guard or the device had; ends with the shift. Its alarms raise the guard’s SOS from the post.',
  })
  @ApiOkResponse({ type: PairedAlarmDeviceView })
  async pair(@Body() dto: PairAlarmDeviceDto): Promise<PairedAlarmDeviceView> {
    return PairedAlarmDeviceView.from(await this.devices.pair(dto.deviceId));
  }

  @Post('unpair')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unpair your wearable' })
  @ApiNoContentResponse()
  async unpair(): Promise<void> {
    await this.devices.unpair();
  }
}
