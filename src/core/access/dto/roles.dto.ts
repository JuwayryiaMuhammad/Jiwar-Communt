import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

export class ReplacePermissionsDto {
  @ApiProperty({
    type: [String],
    description:
      'The whole set; keys from GET /permissions. The manager role keeps roles.manage and residents.manage.',
  })
  @IsArray()
  @ArrayMaxSize(200, withParams({ max: 200 }))
  @IsString({ each: true })
  permissions: string[];
}
