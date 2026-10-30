import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { IdScanDto } from './dto/id-scan.dto';
import { IdScansService } from './id-scans.service';
import { IdScanView } from './views/id-scan.views';

/** A guard's ID scan (ADR 0068). */
@ApiArea('blocklist')
@RequirePermissions('gate.operate')
@Controller('gate/id-scans')
export class GateIdScansController {
  constructor(private readonly scans: IdScansService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Read a document',
    description:
      'Inside an open shift at a gate, on the guard’s own rate limit. What the document says, for this device once: never stored, never logged, audited only by its outcome. The image is deleted whatever came of it. 422 ID_SCAN_UNREADABLE: type the number instead; 503 VENDOR_UNAVAILABLE: the vendor did not answer.',
  })
  @ApiOkResponse({ type: IdScanView })
  async scan(@Body() dto: IdScanDto): Promise<IdScanView> {
    return IdScanView.from(await this.scans.scan(dto.imageFileId));
  }
}
