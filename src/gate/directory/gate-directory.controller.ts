import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { GateDirectoryService } from './gate-directory.service';
import { GateDirectoryView } from './views/gate-directory.views';

/** The gate directory, for a guard on duty (ADR 0056). */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate/directory')
export class GateDirectoryController {
  constructor(private readonly directory: GateDirectoryService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The gates, their phones and who is on shift where',
    description:
      'For a guard on duty at any post (NO_OPEN_SHIFT otherwise). Guards by first name only; the only phones are the gates’ own.',
  })
  @ApiOkResponse({ type: GateDirectoryView })
  async get(): Promise<GateDirectoryView> {
    return GateDirectoryView.from(await this.directory.directory());
  }
}
