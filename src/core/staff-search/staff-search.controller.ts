import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { RequireAnyPermission } from '../access/require-permissions.decorator';
import { ApiArea, NoStore } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { withParams } from '../common/validation/validation-errors';
import {
  STAFF_SEARCH_TYPES,
  type StaffSearchHit,
  type StaffSearchType,
} from './staff-search';
import { StaffSearchService } from './staff-search.service';

export class StaffSearchQueryDto {
  @ApiProperty({
    type: String,
    minLength: 2,
    maxLength: 64,
    description: 'A reference (`MT-000123`, `123`) or words: a code, a name.',
  })
  @IsString()
  @Length(2, 64, withParams({ min: 2, max: 64 }))
  q: string;
}

export class StaffSearchHitView {
  @ApiProperty({ enum: STAFF_SEARCH_TYPES })
  type: StaffSearchType;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'A code, a name or a reference.' })
  title: string;
  @ApiProperty({ type: String, nullable: true })
  subtitle: string | null;

  static from(h: StaffSearchHit): StaffSearchHitView {
    return { type: h.type, id: h.id, title: h.title, subtitle: h.subtitle };
  }
}

/**
 * The top bar's search (ADR 0072): for whoever may read at least one of its
 * sources (the permissions of the units', people's, tickets' and assets'
 * lists), so a resident is refused before the query is read.
 */
@ApiArea('search')
@RequireAnyPermission(
  'units.manage',
  'units.directory',
  'residents.read',
  'accounts.read',
  'tickets.dispatch',
  'maintenance.manage',
  'assets.read',
)
@Controller('staff/search')
export class StaffSearchController {
  constructor(private readonly search: StaffSearchService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Search units, buildings, people, tickets and assets I may read',
    description:
      'The staff and the manager who may read at least one kind; a resident is FORBIDDEN (GET /me/search is theirs). At most 8 of a kind, by kind; each kind only with the permission of its own list. 60 searches a minute.',
  })
  @ApiOkResponse({ type: ListOf(StaffSearchHitView) })
  async find(
    @Query() q: StaffSearchQueryDto,
  ): Promise<ListResponse<StaffSearchHitView>> {
    return bounded(await this.search.find(q.q), (h) =>
      StaffSearchHitView.from(h),
    );
  }
}
