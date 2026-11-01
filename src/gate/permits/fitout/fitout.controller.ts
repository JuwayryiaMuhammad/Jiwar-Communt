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
import {
  AddPermitDrawingDto,
  CancelDebrisSlotDto,
  RecordAreaDto,
  ScheduleDebrisSlotDto,
} from './dto/fitout.dto';
import { AreaRecordsService } from './area-records.service';
import { DebrisSlotsService } from './debris-slots.service';
import { debrisSlotRead, FitOutService } from './fitout.service';
import { PermitDrawingsService } from './permit-drawings.service';
import { DebrisSlotView, FitOutView } from './views/fitout.views';

const SCHEDULE =
  'An approved works permit that has not ended (PERMIT_NOT_ACTIVE); a work day of its period inside the compound’s hours, 30 minutes to 4 hours, starting ahead; three scheduled at once (DEBRIS_SLOT_LIMIT), never overlapping.';

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
    private readonly debris: DebrisSlotsService,
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

  @Post('debris-slots')
  @NoStore()
  @ApiOperation({
    summary: 'Schedule a debris removal of the works',
    description: SCHEDULE,
  })
  @ApiCreatedResponse({ type: FitOutView })
  async schedule(
    @Param('id', parseId()) id: string,
    @Body() dto: ScheduleDebrisSlotDto,
  ): Promise<FitOutView> {
    await this.debris.schedule(id, 'resident', dto);
    return this.view(id);
  }

  @Post('debris-slots/:slotId/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Call off a debris removal the household scheduled',
    description:
      'Before its window starts (DEBRIS_SLOT_CLOSED), with a code from `debrisSlotCancel`.',
  })
  @ApiOkResponse({ type: FitOutView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Param('slotId', parseId('slotId')) slotId: string,
    @Body() dto: CancelDebrisSlotDto,
  ): Promise<FitOutView> {
    await this.debris.cancel(id, slotId, 'resident', dto);
    return this.view(id);
  }
}

/** A works permit's fit-out, the management's side (ADR 0074). */
@ApiArea('permits')
@RequirePermissions('permits.manage')
@Controller('staff/unit-permits/:id')
export class StaffFitOutController {
  constructor(
    private readonly fitOut: FitOutService,
    private readonly debris: DebrisSlotsService,
    private readonly areas: AreaRecordsService,
  ) {}

  private view = async (id: string) =>
    FitOutView.from(await this.fitOut.get(id, 'staff'));

  @Post('area-records')
  @NoStore()
  @ApiOperation({
    summary: 'Record a common area before or after the works',
    description:
      'One to ten photos and a note the household reads; once per area and stage.',
  })
  @ApiCreatedResponse({ type: FitOutView })
  async recordArea(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordAreaDto,
  ): Promise<FitOutView> {
    await this.areas.record(id, dto);
    return this.view(id);
  }

  @Get('fit-out')
  @NoStore()
  @ApiOperation({
    summary: 'A works permit’s deposit, drawings and debris removals',
  })
  @ApiOkResponse({ type: FitOutView })
  async get(@Param('id', parseId()) id: string): Promise<FitOutView> {
    return this.view(id);
  }

  @Post('debris-slots')
  @NoStore()
  @ApiOperation({
    summary: 'Schedule a debris removal of the works',
    description: SCHEDULE,
  })
  @ApiCreatedResponse({ type: FitOutView })
  async schedule(
    @Param('id', parseId()) id: string,
    @Body() dto: ScheduleDebrisSlotDto,
  ): Promise<FitOutView> {
    await this.debris.schedule(id, 'staff', dto);
    return this.view(id);
  }

  @Post('debris-slots/:slotId/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Call off a debris removal',
    description:
      'Any of the permit’s, before its window starts (DEBRIS_SLOT_CLOSED), with a code from `debrisSlotCancel`.',
  })
  @ApiOkResponse({ type: FitOutView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Param('slotId', parseId('slotId')) slotId: string,
    @Body() dto: CancelDebrisSlotDto,
  ): Promise<FitOutView> {
    await this.debris.cancel(id, slotId, 'staff', dto);
    return this.view(id);
  }

  @Post('debris-slots/:slotId/done')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Mark a debris removal done',
    description:
      'From half an hour before its window until the sweep marks it missed, two hours past its end (DEBRIS_SLOT_CLOSED).',
  })
  @ApiOkResponse({ type: FitOutView })
  async done(
    @Param('id', parseId()) id: string,
    @Param('slotId', parseId('slotId')) slotId: string,
  ): Promise<FitOutView> {
    await this.debris.done(id, slotId, 'staff');
    return this.view(id);
  }
}

/** A works permit's debris removals at the gate (ADR 0074), inside a shift. */
@ApiArea('permits')
@RequirePermissions('gate.operate')
@Controller('gate/unit-permits/:id/debris-slots')
export class GateDebrisSlotsController {
  constructor(private readonly debris: DebrisSlotsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'A works permit’s debris removals scheduled today',
    description: 'An open shift (NO_OPEN_SHIFT).',
  })
  @ApiOkResponse({ type: [DebrisSlotView] })
  async today(@Param('id', parseId()) id: string): Promise<DebrisSlotView[]> {
    return (await this.debris.today(id)).map((d) =>
      DebrisSlotView.from(debrisSlotRead(d)),
    );
  }

  @Post(':slotId/done')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoStore()
  @ApiOperation({
    summary: 'Mark a debris removal done at the gate',
    description:
      'A guard on shift, from half an hour before its window until it is missed (DEBRIS_SLOT_CLOSED).',
  })
  async done(
    @Param('id', parseId()) id: string,
    @Param('slotId', parseId('slotId')) slotId: string,
  ): Promise<void> {
    await this.debris.done(id, slotId, 'gate');
  }
}
