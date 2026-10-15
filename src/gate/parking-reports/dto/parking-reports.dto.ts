import { ApiProperty } from '@nestjs/swagger';
import { ParkingReportStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PLATE_MAX } from '../../../core/common/vehicle-plate';
import { LOCATION, REPORT_NOTE } from '../parking-reports.service';

export class CreateParkingReportDto {
  @ApiProperty({
    type: String,
    maxLength: PLATE_MAX,
    description: 'As read off the car.',
  })
  @IsString()
  plate: string;

  @ApiProperty({
    type: String,
    minLength: LOCATION.min,
    maxLength: LOCATION.max,
    example: 'Visitor area B, by the gym',
  })
  @IsString()
  location: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: REPORT_NOTE.min,
    maxLength: REPORT_NOTE.max,
  })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A finalized `parking_photo` upload of the caller.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class StaffParkingReportsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ParkingReportStatus,
    enumName: 'ParkingReportStatus',
    required: false,
    description:
      '`open` is the queue, oldest first; anything else newest first.',
  })
  @IsOptional()
  @IsEnum(
    ParkingReportStatus,
    withParams({ allowed: Object.values(ParkingReportStatus) }),
  )
  status?: ParkingReportStatus;
}

export class CloseParkingReportDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `parkingReportClose`.',
  })
  @IsString()
  reasonCode: string;
}
