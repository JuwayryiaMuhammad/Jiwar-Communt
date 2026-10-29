import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { QUOTE_AMOUNT, QUOTE_NOTE_MAX } from '../quote-rules';

export class ProposeQuoteDto {
  @ApiProperty({
    type: String,
    pattern: QUOTE_AMOUNT.source,
    description: 'EGP, e.g. `350` or `350.50`; below ten million.',
  })
  @IsString()
  @Matches(QUOTE_AMOUNT)
  amount: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: QUOTE_NOTE_MAX,
    description: 'What the residents read: the work and what it includes.',
  })
  @IsOptional()
  @IsString()
  @Length(1, QUOTE_NOTE_MAX, withParams({ min: 1, max: QUOTE_NOTE_MAX }))
  note?: string;
}

/** The technician's price (ADR 0065): as a quote's, for dispatch to send. */
export class SuggestQuoteDto extends ProposeQuoteDto {}

/** Sending a suggestion, as it is or amended (ADR 0065). */
export class SendSuggestionDto {
  @ApiProperty({
    type: String,
    required: false,
    pattern: QUOTE_AMOUNT.source,
    description: 'EGP; the suggestion’s amount when left out.',
  })
  @IsOptional()
  @IsString()
  @Matches(QUOTE_AMOUNT)
  amount?: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: QUOTE_NOTE_MAX,
    description:
      'What the residents read; the suggestion’s note when left out.',
  })
  @IsOptional()
  @IsString()
  @Length(1, QUOTE_NOTE_MAX, withParams({ min: 1, max: QUOTE_NOTE_MAX }))
  note?: string;
}
