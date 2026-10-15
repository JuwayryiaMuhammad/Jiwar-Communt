import {
  Body,
  Controller,
  Delete,
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
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  ApproveVehicleDto,
  CreateVehicleDto,
  RejectVehicleDto,
  RemoveVehicleQueryDto,
  RenewVehicleDto,
  StaffRemoveVehicleDto,
  StaffVehiclesQueryDto,
  UpdateVehicleDto,
  UpdateVehicleSettingsDto,
} from './dto/vehicles.dto';
import { StaffVehiclesService } from './staff-vehicles.service';
import { VehicleSettingsService } from './vehicle-settings.service';
import { VehiclesService } from './vehicles.service';
import {
  StaffVehicleDetailView,
  StaffVehicleView,
  VehicleSettingsResponse,
  VehicleView,
} from './views/vehicle.views';

/**
 * A unit's vehicles, for its people (ADR 0045): `vehicles.register`, and
 * `capabilities.vehicles` on the unit. Every response is `no-store`: it
 * carries plates and a presigned photo URL.
 */
@ApiArea('vehicles')
@RequirePermissions('vehicles.register')
@Controller()
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get('units/:unitId/vehicles')
  @NoStore()
  @ApiOperation({
    summary: 'List the unit’s vehicles',
    description:
      'For whoever holds `vehicles` on the unit. Removed vehicles are gone.',
  })
  @ApiOkResponse({ type: ListOf(VehicleView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<VehicleView>> {
    return bounded(await this.vehicles.list(unitId), (v) =>
      VehicleView.from(v),
    );
  }

  @Post('units/:unitId/vehicles')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Register a vehicle for the unit',
    description:
      '`pending` until the staff approve it. At most the compound’s `maxVehiclesPerUnit` pending or active vehicles per unit (VEHICLE_LIMIT_REACHED).',
  })
  @ApiCreatedResponse({ type: VehicleView })
  async create(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateVehicleDto,
  ): Promise<VehicleView> {
    return VehicleView.from(await this.vehicles.create(unitId, dto));
  }

  @Get('vehicles/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of the unit’s vehicles' })
  @ApiOkResponse({ type: VehicleView })
  async get(@Param('id', parseId()) id: string): Promise<VehicleView> {
    return VehicleView.from(await this.vehicles.get(id));
  }

  @Patch('vehicles/:id')
  @NoStore()
  @ApiOperation({
    summary: 'Edit a vehicle',
    description:
      'Its registrant or the unit’s primary (VEHICLE_ACTION_NOT_ALLOWED). A new plate sends it back to `pending` and voids its sticker; colour, model, type and the photo keep its status.',
  })
  @ApiOkResponse({ type: VehicleView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateVehicleDto,
  ): Promise<VehicleView> {
    return VehicleView.from(await this.vehicles.update(id, dto));
  }

  @Delete('vehicles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a vehicle',
    description:
      'Its registrant or the unit’s primary. Final: its sticker and permit are void; the licence photo is deleted 30 days later.',
  })
  @ApiNoContentResponse()
  async remove(
    @Param('id', parseId()) id: string,
    @Query() q: RemoveVehicleQueryDto,
  ): Promise<void> {
    await this.vehicles.remove(id, q.reasonCode);
  }
}

/** The compound's vehicles, for the staff (ADR 0045): `vehicles.manage`. */
@ApiArea('vehicles')
@RequirePermissions('vehicles.manage')
@Controller('staff/vehicles')
export class StaffVehiclesController {
  constructor(private readonly vehicles: StaffVehiclesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the compound’s vehicles',
    description: '`status=pending` is the approvals queue, oldest first.',
  })
  @ApiOkResponse({ type: ListOf(StaffVehicleView) })
  async list(
    @Query() q: StaffVehiclesQueryDto,
  ): Promise<ListResponse<StaffVehicleView>> {
    return toList(await this.vehicles.list(q), (v) => StaffVehicleView.from(v));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a vehicle with its licence photo' })
  @ApiOkResponse({ type: StaffVehicleDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffVehicleDetailView> {
    return StaffVehicleDetailView.detail(await this.vehicles.get(id));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Approve a pending vehicle: a sticker and a permit’s last day',
    description:
      'As read (`version`, VEHICLE_CHANGED). One active permit per plate (VEHICLE_PLATE_ACTIVE); a sticker number is issued once, ever.',
  })
  @ApiOkResponse({ type: StaffVehicleDetailView })
  async approve(
    @Param('id', parseId()) id: string,
    @Body() dto: ApproveVehicleDto,
  ): Promise<StaffVehicleDetailView> {
    return StaffVehicleDetailView.detail(await this.vehicles.approve(id, dto));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Reject a pending vehicle, with a reason code' })
  @ApiOkResponse({ type: StaffVehicleDetailView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: RejectVehicleDto,
  ): Promise<StaffVehicleDetailView> {
    return StaffVehicleDetailView.detail(await this.vehicles.reject(id, dto));
  }

  @Post(':id/renew')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Renew an active permit: a new last day' })
  @ApiOkResponse({ type: StaffVehicleDetailView })
  async renew(
    @Param('id', parseId()) id: string,
    @Body() dto: RenewVehicleDto,
  ): Promise<StaffVehicleDetailView> {
    return StaffVehicleDetailView.detail(
      await this.vehicles.renew(id, dto.permitValidUntil),
    );
  }

  @Post(':id/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoStore()
  @ApiOperation({ summary: 'Remove a vehicle, with a reason code' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', parseId()) id: string,
    @Body() dto: StaffRemoveVehicleDto,
  ): Promise<void> {
    await this.vehicles.remove(id, dto.reasonCode);
  }
}

/** The compound's vehicle and parking settings (ADR 0045). */
@ApiArea('vehicles')
@RequirePermissions('vehicles.manage')
@Controller('staff/vehicle-settings')
export class VehicleSettingsController {
  constructor(private readonly settings: VehicleSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the vehicle and parking settings' })
  @ApiOkResponse({ type: VehicleSettingsResponse })
  async get(): Promise<VehicleSettingsResponse> {
    return VehicleSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({
    summary: 'Change the vehicle and parking settings',
    description: 'A lower limit leaves what a unit holds already.',
  })
  @ApiOkResponse({ type: VehicleSettingsResponse })
  async update(
    @Body() dto: UpdateVehicleSettingsDto,
  ): Promise<VehicleSettingsResponse> {
    return VehicleSettingsResponse.from(await this.settings.update(dto));
  }
}
