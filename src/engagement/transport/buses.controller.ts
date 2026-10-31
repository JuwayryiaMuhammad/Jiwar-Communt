import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import type { BusDeparture, BusRoute } from '@prisma/client';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  BusesService,
  weekdaysOf,
  type NextDeparture,
  type RouteWithDepartures,
} from './buses.service';
import {
  AddBusDepartureDto,
  CreateBusRouteDto,
  UpdateBusRouteDto,
} from './dto/buses.dto';

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export class BusDepartureView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: [Number], description: '0 is Sunday, 6 Saturday.' })
  weekdays: number[];
  @ApiProperty({
    type: String,
    example: '07:30',
    description: 'Local time of day.',
  })
  time: string;
  @ApiProperty({ type: String })
  fromStop: string;
  @ApiProperty({ type: String })
  toStop: string;

  static from(d: BusDeparture): BusDepartureView {
    return {
      id: d.id,
      weekdays: weekdaysOf(d.weekdays),
      time: hhmm(d.departsMinute),
      fromStop: d.fromStop,
      toStop: d.toStop,
    };
  }
}

export class BusRouteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: [BusDepartureView] })
  departures: BusDepartureView[];

  static from(r: BusRoute & { departures?: BusDeparture[] }): BusRouteView {
    return {
      id: r.id,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      active: r.active,
      departures: (r.departures ?? []).map((d) => BusDepartureView.from(d)),
    };
  }
}

export class NextBusView {
  @ApiProperty({ type: String, format: 'uuid' })
  routeId: string;
  @ApiProperty({ type: String })
  routeNameEn: string;
  @ApiProperty({ type: String })
  routeNameAr: string;
  @ApiProperty({ type: String, format: 'uuid' })
  departureId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({ type: String })
  fromStop: string;
  @ApiProperty({ type: String })
  toStop: string;

  static from(n: NextDeparture): NextBusView {
    return {
      routeId: n.route.id,
      routeNameEn: n.route.nameEn,
      routeNameAr: n.route.nameAr,
      departureId: n.departure.id,
      at: n.at,
      fromStop: n.departure.fromStop,
      toStop: n.departure.toStop,
    };
  }
}

export class BusesView {
  @ApiProperty({ type: [BusRouteView], description: 'The routes running.' })
  routes: BusRouteView[];
  @ApiProperty({
    type: [NextBusView],
    description: 'The next departures, today’s and tomorrow’s.',
  })
  next: NextBusView[];
}

/** The buses, for residents (ADR 0071). */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('buses')
export class BusesController {
  constructor(private readonly buses: BusesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the buses’ timetable and the next departures' })
  @ApiOkResponse({ type: BusesView })
  async get(): Promise<BusesView> {
    const routes: RouteWithDepartures[] = await this.buses.routes(false);
    return {
      routes: routes.map((r) => BusRouteView.from(r)),
      next: (await this.buses.nextNow()).map((n) => NextBusView.from(n)),
    };
  }
}

/** The manager keeps the buses' timetable (ADR 0071). */
@ApiArea('community')
@RequirePermissions('content.manage')
@Controller('community')
export class StaffBusesController {
  constructor(private readonly buses: BusesService) {}

  @Get('bus-routes')
  @NoStore()
  @ApiOperation({ summary: 'List every bus route, retired ones too' })
  @ApiOkResponse({ type: ListOf(BusRouteView) })
  async list(): Promise<ListResponse<BusRouteView>> {
    return bounded(await this.buses.routes(true), (r) => BusRouteView.from(r));
  }

  @Post('bus-routes')
  @NoStore()
  @ApiOperation({ summary: 'Add a bus route' })
  @ApiCreatedResponse({ type: BusRouteView })
  async create(@Body() dto: CreateBusRouteDto): Promise<BusRouteView> {
    return BusRouteView.from(await this.buses.createRoute(dto));
  }

  @Patch('bus-routes/:id')
  @NoStore()
  @ApiOperation({ summary: 'Rename or retire a bus route' })
  @ApiOkResponse({ type: BusRouteView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateBusRouteDto,
  ): Promise<BusRouteView> {
    return BusRouteView.from(await this.buses.updateRoute(id, dto));
  }

  @Post('bus-routes/:id/departures')
  @NoStore()
  @ApiOperation({ summary: 'Add a departure to a route' })
  @ApiCreatedResponse({ type: BusDepartureView })
  async add(
    @Param('id', parseId()) id: string,
    @Body() dto: AddBusDepartureDto,
  ): Promise<BusDepartureView> {
    return BusDepartureView.from(await this.buses.addDeparture(id, dto));
  }

  @Delete('bus-departures/:id')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Remove a departure that no longer runs' })
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.buses.removeDeparture(id);
  }
}
