import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import type { ReasonInput } from '../reasons';

/**
 * `{ reasonCode, reason }` on every reason-taking endpoint. Only the types
 * are checked here: presence and the closed list belong to the service
 * (`REASON_REQUIRED`, `INVALID_REASON_CODE` with `allowed`), so the codes
 * are the same over HTTP and in-process.
 */
export class ReasonDto {
  @ApiProperty({
    type: String,
    description:
      'A code from the closed list for this action; see `allowed` on INVALID_REASON_CODE.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiProperty({
    type: String,
    description:
      'What the person is told (at most 1000 characters). Never stored in the audit trail.',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * `{ reasonCode }` alone, where nobody is told a text (ADR 0036): the code
 * is checked by the service against its closed list.
 */
export class ReasonCodeOnlyDto {
  @ApiProperty({
    type: String,
    description:
      'A code from the closed list for this action; see `allowed` on INVALID_REASON_CODE.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export function reasonOf(dto: {
  reasonCode?: string;
  reason?: string;
}): ReasonInput {
  return { code: dto.reasonCode, text: dto.reason };
}
