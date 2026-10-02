import { ApiProperty } from '@nestjs/swagger';
import { FilePurpose } from '@prisma/client';
import { IsEnum, IsInt, IsString, Length, Min } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';
import { FILE_TYPES } from '../purposes';

export class NewUploadDto {
  @ApiProperty({ enum: FilePurpose, enumName: 'FilePurpose' })
  @IsEnum(FilePurpose, withParams({ allowed: Object.values(FilePurpose) }))
  purpose: FilePurpose;

  @ApiProperty({
    type: String,
    enum: FILE_TYPES,
    description:
      'Signed into the upload. The purpose decides which types it takes (FILE_TYPE_NOT_ALLOWED).',
  })
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  contentType: string;

  @ApiProperty({
    type: Number,
    minimum: 1,
    description:
      'Bytes, signed into the upload. The purpose sets the limit (FILE_TOO_LARGE).',
  })
  @IsInt(withParams({ min: 1 }))
  @Min(1, withParams({ min: 1 }))
  size: number;
}
