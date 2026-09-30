import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional } from 'class-validator';
import { IsPhone } from '../../common/validation/is-phone';

/**
 * A new login phone and/or email. Pending codes sent to the old address
 * stop working in the same transaction (ADR 0014).
 */
export class ContactDto {
  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsPhone()
  phone?: string;

  @ApiProperty({ type: String, format: 'email', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;
}
