import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';
import { PeopleSearchQueryDto } from './people-search-query.dto';

/** Which side of the compound an account list is narrowed to. */
export const ACCOUNT_GROUPS = ['staff', 'managers', 'households'] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

/**
 * `GET /accounts` (ADR 0072): the page, the search, and what a picker needs
 * to ask for itself — the staff to own an item, the managers to be named,
 * the households' people to ban — instead of filtering one page of 100.
 */
export class AccountsQueryDto extends PeopleSearchQueryDto {
  @ApiPropertyOptional({
    enum: ACCOUNT_GROUPS,
    enumName: 'AccountGroup',
    description:
      '`staff`: staff and manager accounts; `managers`: manager accounts; `households`: resident and family accounts.',
  })
  @IsOptional()
  @IsIn(ACCOUNT_GROUPS, withParams({ allowed: [...ACCOUNT_GROUPS] }))
  group?: AccountGroup;

  @ApiPropertyOptional({
    enum: ['true'],
    description: '`true`: only the accounts that can sign in now (active).',
  })
  @IsOptional()
  @IsIn(['true'], withParams({ allowed: ['true'] }))
  active?: 'true';
}
