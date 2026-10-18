import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { IdLookupDto } from './dto/blocklist.dto';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { BlocklistService } from './blocklist.service';
import { IdLookupService } from './id-lookup.service';
import { GuardBlocklistEntryView, IdLookupView } from './views/blocklist.views';

/** The active blocklist, for a guard on shift (ADR 0053). */
@ApiArea('blocklist')
@RequirePermissions('gate.operate')
@Controller('gate/blocklist')
export class GateBlocklistController {
  constructor(private readonly blocklist: BlocklistService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The active blocklist',
    description:
      'For a guard on shift (a gate or a zone): each entry’s kind, plate or name, and face. Never why, never an ID number.',
  })
  @ApiOkResponse({ type: [GuardBlocklistEntryView] })
  async active(): Promise<GuardBlocklistEntryView[]> {
    return (await this.blocklist.active()).map((r) =>
      GuardBlocklistEntryView.from(r),
    );
  }
}

/** The guard's ID lookup against the blocklist (ADR 0053). */
@ApiArea('blocklist')
@RequirePermissions('gate.operate')
@Controller('gate/id-lookup')
export class GateIdLookupController {
  constructor(private readonly ids: IdLookupService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Look an ID number up on the blocklist',
    description:
      'Inside an open shift at a gate, on the guard’s own rate limit. Answers the person’s live entries (kind, name, face) and nothing else. Audited by the entries’ ids, never the number.',
  })
  @ApiOkResponse({ type: IdLookupView })
  async lookup(@Body() dto: IdLookupDto): Promise<IdLookupView> {
    return {
      matches: (await this.ids.lookup(dto.idNumber)).map((r) =>
        GuardBlocklistEntryView.from(r),
      ),
    };
  }
}
