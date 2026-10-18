import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { ExclusiveWith } from '../../../core/common/validation/exclusive-with';
import { withParams } from '../../../core/common/validation/validation-errors';

export class ChildCardDto {
  @ApiProperty({
    type: String,
    description: "The child card's QR, `JWC1.<token>`.",
  })
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  card: string;
}

/** Who takes the child: exactly one of the four. */
export class ExitEscortDto {
  @ApiProperty({
    type: String,
    required: false,
    description:
      "A resident's entry QR (`JWR2…`), a worker's card (`JWR1…`) or a pickup QR (`JWP1…`).",
  })
  @IsOptional()
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  @ExclusiveWith('code')
  @ExclusiveWith('alone')
  @ExclusiveWith('unidentified')
  qr?: string;

  @ApiProperty({
    type: String,
    required: false,
    description: "A worker's 8-digit code, or a pickup code's 6 digits.",
  })
  @IsOptional()
  @IsString()
  @Length(1, 16, withParams({ min: 1, max: 16 }))
  @ExclusiveWith('alone')
  @ExclusiveWith('unidentified')
  code?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'The child is leaving alone.',
  })
  @IsOptional()
  @Equals(true)
  @ExclusiveWith('unidentified')
  alone?: true;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Someone with nothing to scan wants to take the child: refused, and the household and the keepers are alerted.',
  })
  @IsOptional()
  @Equals(true)
  unidentified?: true;
}

export class ChildExitDto extends ChildCardDto {
  @ApiProperty({ type: ExitEscortDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ExitEscortDto)
  escort: ExitEscortDto;
}
