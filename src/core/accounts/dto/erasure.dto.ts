import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

export class EraseDto {
  @ApiProperty({
    type: String,
    description: 'The `scopePhrase` from step 1, typed exactly.',
  })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  typedScope: string;
}
