import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ASR_MADHABS, PRAYER_METHODS } from './prayer-times';
import { PrayerTimesQueryDto, UpdatePrayerSettingsDto } from './dto/prayer.dto';
import {
  PrayerService,
  type PrayerRead,
  type PrayerSettingsView as Settings,
} from './prayer.service';

/** A day's prayer times at the compound: instants. */
export class PrayerTimesView {
  @ApiProperty({ type: String, format: 'date' })
  on: string;
  @ApiProperty({ type: String, example: 'Africa/Cairo' })
  timeZone: string;
  @ApiProperty({ type: String, format: 'date-time' })
  fajr: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  sunrise: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  dhuhr: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  asr: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  maghrib: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  isha: Date;

  static from(r: PrayerRead): PrayerTimesView {
    return { ...r };
  }
}

export class PrayerSettingsView {
  @ApiProperty({ type: String, nullable: true })
  latitude: string | null;
  @ApiProperty({ type: String, nullable: true })
  longitude: string | null;
  @ApiProperty({ enum: PRAYER_METHODS })
  prayerMethod: string;
  @ApiProperty({ enum: ASR_MADHABS })
  asrMadhab: string;

  static from(s: Settings): PrayerSettingsView {
    return { ...s };
  }
}

/** Prayer times, for residents (ADR 0071). */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('prayer-times')
export class PrayerTimesController {
  constructor(private readonly prayer: PrayerService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get a day’s prayer times at the compound' })
  @ApiOkResponse({ type: PrayerTimesView })
  async get(@Query() q: PrayerTimesQueryDto): Promise<PrayerTimesView> {
    return PrayerTimesView.from(await this.prayer.get(q.on));
  }
}

/** Where the compound is, for its prayer times (ADR 0071). */
@ApiArea('community')
@RequirePermissions('content.manage')
@Controller('community/prayer-settings')
export class PrayerSettingsController {
  constructor(private readonly prayer: PrayerService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Get where the compound is and how prayer times are computed',
  })
  @ApiOkResponse({ type: PrayerSettingsView })
  async get(): Promise<PrayerSettingsView> {
    return PrayerSettingsView.from(await this.prayer.settings());
  }

  @Patch()
  @NoStore()
  @ApiOperation({
    summary: 'Set where the compound is and how prayer times are computed',
  })
  @ApiOkResponse({ type: PrayerSettingsView })
  async update(
    @Body() dto: UpdatePrayerSettingsDto,
  ): Promise<PrayerSettingsView> {
    return PrayerSettingsView.from(await this.prayer.update(dto));
  }
}
