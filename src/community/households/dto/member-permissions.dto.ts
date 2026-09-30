import { ApiProperty } from '@nestjs/swagger';
import { MemberPermission } from '@prisma/client';
import { IsIn, IsOptional } from 'class-validator';
import { ReasonDto } from '../../../core/common/http/reason.dto';
import { withParams } from '../../../core/common/validation/validation-errors';

const PERMISSIONS = Object.values(MemberPermission);
const ANY = [...PERMISSIONS, 'all'] as const;
const DECISIONS = ['approve', 'decline'] as const;

export class GrantDto {
  @ApiProperty({ enum: MemberPermission, enumName: 'MemberPermission' })
  @IsIn(PERMISSIONS, withParams({ allowed: PERMISSIONS }))
  permission: MemberPermission;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    required: false,
    example: '500.00',
    description:
      'Finance only, required there: the cap per operation (checked by the service).',
  })
  @IsOptional()
  capPerOperation?: string | number;
}

export class RevokeDto extends ReasonDto {
  @ApiProperty({ enum: MemberPermission, enumName: 'MemberPermission' })
  @IsIn(PERMISSIONS, withParams({ allowed: PERMISSIONS }))
  permission: MemberPermission;
}

export class RevokeByManagementDto extends ReasonDto {
  @ApiProperty({ enum: ANY })
  @IsIn(ANY, withParams({ allowed: [...ANY] }))
  permission: MemberPermission | 'all';
}

/** A decline needs a reason; an approval takes none. */
export class DecideDto extends ReasonDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS, withParams({ allowed: [...DECISIONS] }))
  decision: (typeof DECISIONS)[number];
}
