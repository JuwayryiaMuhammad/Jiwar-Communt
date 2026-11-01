import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../../core/common/http/decorators';
import { parseId } from '../../../core/common/validation/parse-id.pipe';
import { AddPermitDrawingDto } from './dto/fitout.dto';
import { FitOutService } from './fitout.service';
import { PermitDrawingsService } from './permit-drawings.service';
import { FitOutView } from './views/fitout.views';

/**
 * A works permit's fit-out, its household's side (ADR 0074): the
 * requester or the unit's primary. Any other permit is not found.
 */
@ApiArea('permits')
@RequirePermissions('permits.request')
@Controller('permits/:id')
export class FitOutController {
  constructor(
    private readonly fitOut: FitOutService,
    private readonly drawings: PermitDrawingsService,
  ) {}

  private view = async (id: string) =>
    FitOutView.from(await this.fitOut.get(id, 'resident'));

  @Get('fit-out')
  @NoStore()
  @ApiOperation({ summary: 'A works permit’s deposit and drawings' })
  @ApiOkResponse({ type: FitOutView })
  async get(@Param('id', parseId()) id: string): Promise<FitOutView> {
    return this.view(id);
  }

  @Post('drawings')
  @NoStore()
  @ApiOperation({
    summary: 'Join a drawing to a works permit',
    description:
      'While the permit is pending, or approved and not ended (PERMIT_NOT_ACTIVE); at most 10 at once (PERMIT_DRAWING_LIMIT).',
  })
  @ApiCreatedResponse({ type: FitOutView })
  async addDrawing(
    @Param('id', parseId()) id: string,
    @Body() dto: AddPermitDrawingDto,
  ): Promise<FitOutView> {
    await this.drawings.add(id, dto.fileId);
    return this.view(id);
  }

  @Post('drawings/:drawingId/remove')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Take a drawing off a works permit',
    description: 'While the permit is open; the file stays the record’s.',
  })
  @ApiOkResponse({ type: FitOutView })
  async removeDrawing(
    @Param('id', parseId()) id: string,
    @Param('drawingId', parseId('drawingId')) drawingId: string,
  ): Promise<FitOutView> {
    await this.drawings.remove(id, drawingId);
    return this.view(id);
  }
}

/** A works permit's fit-out, the management's side (ADR 0074). */
@ApiArea('permits')
@RequirePermissions('permits.manage')
@Controller('staff/unit-permits/:id')
export class StaffFitOutController {
  constructor(private readonly fitOut: FitOutService) {}

  @Get('fit-out')
  @NoStore()
  @ApiOperation({ summary: 'A works permit’s deposit and drawings' })
  @ApiOkResponse({ type: FitOutView })
  async get(@Param('id', parseId()) id: string): Promise<FitOutView> {
    return FitOutView.from(await this.fitOut.get(id, 'staff'));
  }
}
