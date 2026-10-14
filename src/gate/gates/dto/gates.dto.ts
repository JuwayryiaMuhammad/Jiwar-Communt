import { ApiProperty } from '@nestjs/swagger';
import { GateKind, GateStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';

const NAME = { min: 1, max: 80 };

export class CreateGateDto {
  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  name: string;

  @ApiProperty({ enum: GateKind, enumName: 'GateKind' })
  @IsEnum(GateKind, withParams({ allowed: Object.values(GateKind) }))
  kind: GateKind;

  @ApiProperty({
    type: String,
    required: false,
    example: '+20225550100',
    description:
      'The gate’s own phone (ADR 0043), stored E.164: a household asked about a visitor can call it.',
  })
  @IsOptional()
  @IsPhone()
  phone?: string;
}

export class UpdateGateDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  name?: string;

  @ApiProperty({ enum: GateKind, enumName: 'GateKind', required: false })
  @IsOptional()
  @IsEnum(GateKind, withParams({ allowed: Object.values(GateKind) }))
  kind?: GateKind;

  @ApiProperty({
    enum: GateStatus,
    enumName: 'GateStatus',
    required: false,
    description: 'Inactive ends the shifts open at the gate.',
  })
  @IsOptional()
  @IsEnum(GateStatus, withParams({ allowed: Object.values(GateStatus) }))
  status?: GateStatus;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: '+20225550100',
    description: 'Stored E.164; `null` removes it (ADR 0043).',
  })
  @IsOptional()
  @IsPhone()
  phone?: string | null;
}
