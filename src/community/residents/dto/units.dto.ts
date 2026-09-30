import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

export class SetPrimaryDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active, residing occupant of the unit.',
  })
  @IsUUID()
  accountId: string;
}

export class ClosedModeDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  closed: boolean;
}

const STEPS = ['unitType', 'areaSqm', 'building'] as const;

export class UnitDetailDto {
  @ApiProperty({ enum: STEPS })
  @IsIn(STEPS, withParams({ allowed: [...STEPS] }))
  step: (typeof STEPS)[number];

  @ApiProperty({
    type: String,
    description: 'Checked per step by the service.',
  })
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  value: string;
}

export class ConvertToOwnerDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False: they let the unit (a landlord).',
  })
  @IsOptional()
  @IsBoolean()
  resides?: boolean;
}

export class ResidenceDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  resides: boolean;
}
