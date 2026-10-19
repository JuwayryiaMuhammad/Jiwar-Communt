import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';

/** A search of the gate log: in a body, so the name is never in a URL. */
export class LogSearchDto {
  @ApiProperty({
    type: String,
    example: '2026-11-01',
    description: 'The compound’s first day. 31 days at most (PERIOD_TOO_LONG).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  from: string;

  @ApiProperty({ type: String, example: '2026-11-04' })
  @IsString()
  @Matches(LOCAL_DATE)
  to: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 200,
    description:
      'A visitor’s full name, matched exactly (case, Arabic letter forms, short vowels and spaces folded): never a part of it or a likeness. Names are deleted 30 days after their pass or request, so a name finds the last 30 days at most. Never stored, logged or audited.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  visitorName?: string;
}
