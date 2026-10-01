import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  ATTENDANCE_MAX_DAYS,
  AttendanceService,
  type Attendance,
} from './attendance.service';

export class AttendanceQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'Default: 30 days before `to`.',
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: `Default: today in the compound. At most ${ATTENDANCE_MAX_DAYS} days from \`from\`.`,
  })
  @IsOptional()
  @IsString()
  to?: string;
}

export class AttendanceDayView {
  @ApiProperty({ type: String, format: 'date' })
  date: string;
  @ApiProperty({ type: String, format: 'date-time' })
  firstIn: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastOut: Date | null;
  @ApiProperty({
    type: Boolean,
    description: 'An exit was closed by the system, not seen by a guard.',
  })
  unconfirmedExit: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'Every visit that day has a confirmed exit.',
  })
  fullDay: boolean;
}

export class AttendanceView {
  @ApiProperty({ type: String, format: 'uuid' })
  engagementId: string;
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: [AttendanceDayView] })
  days: AttendanceDayView[];
  @ApiProperty({ type: Number })
  totalDays: number;

  static from(a: Attendance): AttendanceView {
    return {
      engagementId: a.engagementId,
      from: a.from,
      to: a.to,
      days: a.days.map((d) => ({
        date: d.date,
        firstIn: d.firstIn,
        lastOut: d.lastOut,
        unconfirmedExit: d.unconfirmedExit,
        fullDay: d.fullDay,
      })),
      totalDays: a.totalDays,
    };
  }
}

/** A worker's days at the compound (ADR 0028): dates and times only. */
@ApiArea('workers')
@Controller('worker-engagements')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @RequireAnyPermission('workers.manage', 'workers.review')
  @Get(':id/attendance')
  @ApiOkResponse({ type: AttendanceView })
  async get(
    @Param('id', parseId()) id: string,
    @Query() q: AttendanceQueryDto,
  ): Promise<AttendanceView> {
    return AttendanceView.from(await this.attendance.days(id, q));
  }
}
