import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea, PublicPageHeaders } from '../../core/common/http/decorators';
import { withParams } from '../../core/common/validation/validation-errors';
import { ReceiptPageService, type PublicReceipt } from './receipt-page.service';

const CODE = { min: 1, max: 64 } as const;

export class ReceiptCodeDto {
  @ApiProperty({
    type: String,
    description:
      'The code from the receipt link’s fragment (`/receipt#<code>`).',
  })
  @IsString()
  @Length(CODE.min, CODE.max, withParams(CODE))
  code: string;
}

export class PublicReceiptView implements PublicReceipt {
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({ type: String, example: 'RC-000123' })
  receiptNumber: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, enum: ['EGP'] })
  currency: string;
  @ApiProperty({ type: String, format: 'date' })
  paidOn: string;
  @ApiProperty({
    type: String,
    enum: ['valid', 'reversed'],
    description: '`reversed`: the office reversed this payment.',
  })
  status: 'valid' | 'reversed';
}

/**
 * Verifying a receipt (ADR 0046), for anyone holding its link: the
 * compound, the number, the amount, the day and whether it stands. Never a
 * name or a unit.
 */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/receipts')
export class ReceiptPageController {
  constructor(private readonly page: ReceiptPageService) {}

  @Post('lookup')
  @ApiOperation({ summary: 'Verify a receipt from its link' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PublicReceiptView })
  lookup(
    @Body() dto: ReceiptCodeDto,
    @Ip() ip: string,
  ): Promise<PublicReceiptView> {
    return this.page.lookup(dto.code, ip);
  }
}
