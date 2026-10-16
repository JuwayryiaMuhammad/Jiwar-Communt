import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

/** A gate or a zone (one of the compound's places), exactly one (ADR 0050). */
export class StartShiftDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'A place in service (`GET /community/places`), for a shift that is not at a gate.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}

/** The handover (ADR 0050): every active checklist item ticked, and notes. */
export class EndShiftDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'The ids of the checklist items ticked: every active one (422 HANDOVER_CHECKLIST_INCOMPLETE, params.missing). A retired one is ignored.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, withParams({ max: 100 }))
  @IsUUID(undefined, { each: true })
  checklist?: string[];

  @ApiPropertyOptional({
    type: String,
    maxLength: 2000,
    description: 'For the next guard and the management.',
  })
  @IsOptional()
  @IsString()
  @Length(0, 2000, withParams({ min: 0, max: 2000 }))
  notes?: string;
}
