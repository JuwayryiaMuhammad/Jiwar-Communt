import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import type { OfficeWindow } from './defaults';
import {
  OfficeWindowDto,
  ReplaceOfficeHoursDto,
  UpdateRequestSettingsDto,
} from './dto/request-settings.dto';
import { OfficeHoursService } from './office-hours.service';
import {
  RequestSettingsService,
  type RequestSettingsView,
} from './request-settings.service';

export class RequestSettingsResponse {
  @ApiProperty({
    type: Number,
    description:
      'Days an answered request waits for its author before it closes itself.',
  })
  autoCloseDays: number;
  @ApiProperty({
    type: Number,
    description: 'The length of an appointment slot, in minutes.',
  })
  appointmentSlotMinutes: number;
  @ApiProperty({ type: Number, description: 'Appointments one slot takes.' })
  appointmentSlotCapacity: number;

  static from(s: RequestSettingsView): RequestSettingsResponse {
    return {
      autoCloseDays: s.autoCloseDays,
      appointmentSlotMinutes: s.appointmentSlotMinutes,
      appointmentSlotCapacity: s.appointmentSlotCapacity,
    };
  }
}

export class OfficeHoursResponse {
  @ApiProperty({
    type: [OfficeWindowDto],
    description: 'By weekday, then start. Empty: the office is closed.',
  })
  windows: OfficeWindowDto[];

  static from(windows: readonly OfficeWindow[]): OfficeHoursResponse {
    return {
      windows: windows.map((w) => ({
        weekday: w.weekday,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      })),
    };
  }
}

/** The compound's management request settings (ADR 0039). */
@ApiArea('management-requests')
@RequirePermissions('requests.manage')
@Controller('management/request-settings')
export class RequestSettingsController {
  constructor(private readonly settings: RequestSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the management request settings' })
  @ApiOkResponse({ type: RequestSettingsResponse })
  async get(): Promise<RequestSettingsResponse> {
    return RequestSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({ summary: 'Update the management request settings' })
  @ApiOkResponse({ type: RequestSettingsResponse })
  async update(
    @Body() dto: UpdateRequestSettingsDto,
  ): Promise<RequestSettingsResponse> {
    return RequestSettingsResponse.from(await this.settings.update(dto));
  }
}

/** The compound's office hours, from which appointment slots are cut. */
@ApiArea('management-requests')
@RequirePermissions('requests.manage')
@Controller('management/office-hours')
export class OfficeHoursController {
  constructor(private readonly hours: OfficeHoursService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the office hours' })
  @ApiOkResponse({ type: OfficeHoursResponse })
  async get(): Promise<OfficeHoursResponse> {
    return OfficeHoursResponse.from(await this.hours.get());
  }

  @Put()
  @NoStore()
  @ApiOperation({ summary: 'Replace the office hours' })
  @ApiOkResponse({ type: OfficeHoursResponse })
  async replace(
    @Body() dto: ReplaceOfficeHoursDto,
  ): Promise<OfficeHoursResponse> {
    return OfficeHoursResponse.from(await this.hours.replace(dto.windows));
  }
}

/** The office hours as residents read them (ADR 0058). */
export class ResidentOfficeHoursResponse extends OfficeHoursResponse {
  @ApiProperty({ type: String, example: 'Africa/Cairo' })
  timeZone: string;
  @ApiProperty({
    type: Boolean,
    description: 'Open now, by the server’s clock.',
  })
  openNow: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closesAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Within the coming week; null when no window is set.',
  })
  nextOpensAt: Date | null;
}

/**
 * When the office is open (ADR 0058), for whoever may open a request: the
 * reply times are the topics' own (`targetResponseHours`).
 */
@ApiArea('management-requests')
@RequirePermissions('requests.create')
@Controller('management-office-hours')
export class ResidentOfficeHoursController {
  constructor(private readonly hours: OfficeHoursService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the office hours and whether it is open now' })
  @ApiOkResponse({ type: ResidentOfficeHoursResponse })
  async get(): Promise<ResidentOfficeHoursResponse> {
    const r = await this.hours.forResidents();
    return {
      ...OfficeHoursResponse.from(r.windows),
      timeZone: r.timeZone,
      openNow: r.openNow,
      closesAt: r.closesAt,
      nextOpensAt: r.nextOpensAt,
    };
  }
}
