import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

export class StepUpCodeDto {
  @ApiProperty({ type: String, pattern: '^\\d{6}$' })
  @Matches(/^\d{6}$/, {
    message: 'code must be 6 digits',
    ...withParams({ length: 6 }),
  })
  code: string;
}

export class StepUpView {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: "Until then, this session's next sensitive action may run.",
  })
  expiresAt: Date;
}
