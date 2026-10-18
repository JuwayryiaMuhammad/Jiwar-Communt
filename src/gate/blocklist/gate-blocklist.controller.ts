import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { BlocklistService } from './blocklist.service';
import { GuardBlocklistEntryView } from './views/blocklist.views';

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
