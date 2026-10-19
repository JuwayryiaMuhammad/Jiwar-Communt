import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
import {
  EnrolDeviceDto,
  GateDevicesQueryDto,
  RevokeDeviceDto,
} from './dto/gate-devices.dto';
import { GateDevicesService } from './gate-devices.service';
import {
  GuardDeviceResponse,
  StaffDeviceResponse,
} from './views/gate-device.views';

/** A guard enrols the device the gate works offline on (ADR 0057). */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate/devices')
export class GuardDevicesController {
  constructor(private readonly devices: GateDevicesService) {}

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Enrol this device for the gate offline',
    description:
      'With its Ed25519 public key and the proof that it holds the private key. The same id and key again answer the same; another key under the id is GATE_DEVICE_EXISTS. The `gate_devices.manage` holders are told.',
  })
  @ApiCreatedResponse({ type: GuardDeviceResponse })
  async enrol(@Body() dto: EnrolDeviceDto): Promise<GuardDeviceResponse> {
    return GuardDeviceResponse.from(await this.devices.enrol(dto));
  }
}

/** The management keeps the compound's guard devices (ADR 0057). */
@ApiArea('gate')
@RequirePermissions('gate_devices.manage')
@Controller('staff/gate/devices')
export class StaffDevicesController {
  constructor(private readonly devices: GateDevicesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the guard devices, newest first' })
  @ApiOkResponse({ type: ListOf(StaffDeviceResponse) })
  async list(
    @Query() q: GateDevicesQueryDto,
  ): Promise<ListResponse<StaffDeviceResponse>> {
    return toList(await this.devices.list(q), (v) =>
      StaffDeviceResponse.from(v),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a guard device' })
  @ApiOkResponse({ type: StaffDeviceResponse })
  async get(@Param('id', parseId()) id: string): Promise<StaffDeviceResponse> {
    return StaffDeviceResponse.from(await this.devices.get(id));
  }

  @Post(':id/revoke')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Revoke a guard device',
    description:
      'Once (GATE_DEVICE_ALREADY_REVOKED after). It downloads no bundle again; what it uploads after is quarantined for the management to accept or reject.',
  })
  @ApiOkResponse({ type: StaffDeviceResponse })
  async revoke(
    @Param('id', parseId()) id: string,
    @Body() dto: RevokeDeviceDto,
  ): Promise<StaffDeviceResponse> {
    return StaffDeviceResponse.from(
      await this.devices.revoke(id, dto.reasonCode),
    );
  }
}
