import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  MoveBoardQueryDto,
  MoveOutNoticeDto,
  MoveStepDto,
  NewMoveDto,
} from './dto/moves.dto';
import { MovesService } from './moves.service';
import { BoardMoveView, MoveDetailView, MoveView } from './views/move.views';

/** A resident's moves (ADR 0063): their own occupancies' only. */
@ApiArea('units')
@RequirePermissions('units.read')
@Controller('units/:unitId/moves')
export class MovesController {
  constructor(private readonly moves: MovesService) {}

  @Get()
  @ApiOperation({ summary: 'My moves in and out of the unit' })
  @ApiOkResponse({ type: [MoveView] })
  async mine(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<MoveView[]> {
    return (await this.moves.mine(unitId)).map((m) => MoveView.from(m));
  }

  /** The residing primary's notice; never a delegate's. */
  @Post('move-out')
  @ApiOperation({ summary: 'Give notice to move out' })
  @ApiCreatedResponse({ type: MoveView })
  async noticeMoveOut(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: MoveOutNoticeDto,
  ): Promise<MoveView> {
    return MoveView.from(await this.moves.noticeMoveOut(unitId, dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my moves, with its checklist' })
  @ApiOkResponse({ type: MoveDetailView })
  async open(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<MoveDetailView> {
    return MoveDetailView.from(await this.moves.open(unitId, id));
  }

  @Post(':id/steps')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tick a step of my side' })
  @ApiOkResponse({ type: MoveDetailView })
  async tick(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
    @Body() dto: MoveStepDto,
  ): Promise<MoveDetailView> {
    return MoveDetailView.from(await this.moves.tickMine(unitId, id, dto.step));
  }

  /** Withdraw the notice I gave. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my notice to move out' })
  @ApiOkResponse({ type: MoveView })
  async cancel(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MoveView> {
    return MoveView.from(
      await this.moves.cancelMine(unitId, id, dto.reasonCode),
    );
  }
}

/** The management's moves board (ADR 0063). */
@ApiArea('units')
@RequirePermissions('residents.manage')
@Controller('staff')
export class StaffMovesController {
  constructor(private readonly moves: MovesService) {}

  @Get('moves')
  @ApiOperation({ summary: 'Moves: planned ones, or a unit’s' })
  @ApiOkResponse({ type: [BoardMoveView] })
  async board(@Query() q: MoveBoardQueryDto): Promise<BoardMoveView[]> {
    return (await this.moves.board(q)).map((m) => BoardMoveView.fromBoard(m));
  }

  @Get('moves/:id')
  @ApiOperation({ summary: 'A move, with its checklist' })
  @ApiOkResponse({ type: MoveDetailView })
  async open(@Param('id', parseId()) id: string): Promise<MoveDetailView> {
    return MoveDetailView.from(await this.moves.staffOpen(id));
  }

  @Post('units/:unitId/moves')
  @ApiOperation({ summary: 'Plan a move for an occupancy' })
  @ApiCreatedResponse({ type: MoveView })
  async plan(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewMoveDto,
  ): Promise<MoveView> {
    return MoveView.from(await this.moves.plan(unitId, dto));
  }

  @Post('moves/:id/steps')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tick a step of the management’s side' })
  @ApiOkResponse({ type: MoveDetailView })
  async tick(
    @Param('id', parseId()) id: string,
    @Body() dto: MoveStepDto,
  ): Promise<MoveDetailView> {
    return MoveDetailView.from(await this.moves.tickStaff(id, dto.step));
  }

  /** A move-in happened; a move-out is done at the handover. */
  @Post('moves/:id/done')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a move-in' })
  @ApiOkResponse({ type: MoveView })
  async done(@Param('id', parseId()) id: string): Promise<MoveView> {
    return MoveView.from(await this.moves.confirmIn(id));
  }

  @Post('moves/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a move, with a code' })
  @ApiOkResponse({ type: MoveView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MoveView> {
    return MoveView.from(await this.moves.cancelStaff(id, dto.reasonCode));
  }
}
