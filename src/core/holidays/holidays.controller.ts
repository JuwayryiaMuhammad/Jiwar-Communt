import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../access/require-permissions.decorator';
import { ApiArea, NoStore } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import {
  CreateHolidayDto,
  HolidaysQueryDto,
  UpdateHolidayDto,
} from './dto/holidays.dto';
import { HolidaysService } from './holidays.service';
import { HolidayView } from './views/holidays.views';

/**
 * The compound's holiday calendar, as the management keeps it (ADR 0084).
 * Read by whoever plans around it: the permits, the facilities and the
 * planned work; kept with `spaces.manage`.
 */
@ApiArea('spaces')
@Controller('staff/holidays')
export class StaffHolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission(
    'spaces.manage',
    'permits.manage',
    'facilities.manage',
    'assets.read',
  )
  @ApiOperation({
    summary: 'List the compound’s holidays over up to a year, by day',
  })
  @ApiOkResponse({ type: ListOf(HolidayView) })
  async list(@Query() q: HolidaysQueryDto): Promise<ListResponse<HolidayView>> {
    return bounded(await this.holidays.list(q.from, q.to), (h) =>
      HolidayView.from(h),
    );
  }

  @Post()
  @NoStore()
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Add a holiday',
    description:
      'One a day (HOLIDAY_EXISTS); at most 100 from today on (HOLIDAYS_TOO_MANY). One that stops works refuses works and moves that day from now on, as a permits’ day off did; permits already approved keep their dates.',
  })
  @ApiCreatedResponse({ type: HolidayView })
  async create(@Body() dto: CreateHolidayDto): Promise<HolidayView> {
    return HolidayView.from(await this.holidays.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Change a holiday’s names, or whether works stop on it',
    description: 'Its day is fixed: remove it and add another.',
  })
  @ApiOkResponse({ type: HolidayView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateHolidayDto,
  ): Promise<HolidayView> {
    return HolidayView.from(await this.holidays.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('spaces.manage')
  @ApiOperation({ summary: 'Remove a holiday' })
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.holidays.remove(id);
  }
}

/** The compound's holidays of the coming year, as the apps show them. */
@ApiArea('spaces')
@Controller('community/holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission(
    'facilities.book',
    'permits.request',
    'gate.operate',
    'tickets.work',
  )
  @ApiOperation({
    summary: 'List the compound’s holidays of the coming year',
    description:
      'Today included. `stopsWorks`: no works or moves that day (the permits’ days off).',
  })
  @ApiOkResponse({ type: ListOf(HolidayView) })
  async list(): Promise<ListResponse<HolidayView>> {
    return bounded(await this.holidays.upcoming(), (h) => HolidayView.from(h));
  }
}
