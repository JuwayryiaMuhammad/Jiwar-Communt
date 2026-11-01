import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { BUILDING_NAME_LENGTH } from '../buildings.service';

export class CreateBuildingDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 64,
    description: 'Unique in the compound, exactly as written; never changed.',
  })
  @IsString()
  @Length(
    BUILDING_NAME_LENGTH.min,
    BUILDING_NAME_LENGTH.max,
    withParams({ ...BUILDING_NAME_LENGTH }),
  )
  name: string;
}
