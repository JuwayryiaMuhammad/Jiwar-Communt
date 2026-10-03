import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

export class IssueEntryCredentialDto {
  @ApiProperty({
    type: String,
    required: false,
    example: "Mona's phone",
    description:
      'A label the owner sees in their list (1–60 characters). Kept only while the credential is live; never audited.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60, withParams({ min: 1, max: 60 }))
  deviceName?: string;
}
