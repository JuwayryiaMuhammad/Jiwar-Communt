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
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { FacilityBansService } from './bans.service';
import { BansQueryDto, LiftBanDto, NewBanDto } from './dto/bans.dto';
import { FacilityBanView, OwnFacilityBanView } from './views/bans.views';

/** Accounts banned from booking, for the staff who work the bookings (ADR 0067). */
@ApiArea('bookings')
@RequirePermissions('bookings.handle')
@Controller('staff/facility-bans')
export class FacilityBansController {
  constructor(private readonly bans: FacilityBansService) {}

  @Get()
  @ApiOperation({ summary: 'List the bans, latest first' })
  @ApiOkResponse({ type: ListOf(FacilityBanView) })
  async list(@Query() q: BansQueryDto): Promise<ListResponse<FacilityBanView>> {
    return toList(await this.bans.list(q), (b) => FacilityBanView.from(b));
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Ban an account from booking one facility or all',
    description:
      'Cancels the account’s bookings in that scope that have not started, as the staff cancel one, and lists them. FACILITY_BAN_EXISTS when one in force covers it.',
  })
  @ApiCreatedResponse({ type: FacilityBanView })
  async create(@Body() dto: NewBanDto): Promise<FacilityBanView> {
    return FacilityBanView.from(await this.bans.create(dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One ban, with the bookings it cancelled' })
  @ApiOkResponse({ type: FacilityBanView })
  async get(@Param('id', parseId()) id: string): Promise<FacilityBanView> {
    return FacilityBanView.from(await this.bans.get(id));
  }

  @Post(':id/lift')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lift a ban in force, with a reason code',
    description: 'FACILITY_BAN_OVER once it has ended or was lifted.',
  })
  @ApiOkResponse({ type: FacilityBanView })
  async lift(
    @Param('id', parseId()) id: string,
    @Body() dto: LiftBanDto,
  ): Promise<FacilityBanView> {
    return FacilityBanView.from(await this.bans.lift(id, dto.reasonCode));
  }
}

/** A booker's own bans in force (ADR 0067). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller('me/facility-bans')
export class OwnFacilityBansController {
  constructor(private readonly bans: FacilityBansService) {}

  @Get()
  @ApiOperation({ summary: 'My bans from booking that are in force' })
  @ApiOkResponse({ type: ListOf(OwnFacilityBanView) })
  async mine(): Promise<ListResponse<OwnFacilityBanView>> {
    return bounded(await this.bans.mine(), (b) => OwnFacilityBanView.from(b));
  }
}
