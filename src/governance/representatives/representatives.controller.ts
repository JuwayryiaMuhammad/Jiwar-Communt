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
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { GovernanceOwnerView } from '../board/views/board.views';
import { ProposeRepresentativeMotionDto } from '../motions/dto/motions.dto';
import { MotionsService } from '../motions/motions.service';
import { BoardMotionView } from '../motions/views/motions.views';
import {
  RaiseRepresentativeMatterDto,
  RepresentativeCandidatesQueryDto,
  RepresentativeMattersQueryDto,
  RepresentativeMessageDto,
} from './representatives.dto';
import { RepresentativesService } from './representatives.service';
import {
  BoardRepresentativeMatterView,
  BuildingRepresentativeView,
  RepresentativeMatterView,
  RepresentativeMessageView,
  RepresentativeThreadView,
  RepresentativeView,
} from './representatives.views';

/** Building representatives, the board's side (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/representatives')
export class BoardRepresentativesController {
  constructor(private readonly reps: RepresentativesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'The buildings’ representatives, sitting first' })
  @ApiOkResponse({ type: [RepresentativeView] })
  async list(): Promise<RepresentativeView[]> {
    return (await this.reps.list()).map((r) => RepresentativeView.from(r));
  }

  @Get('buildings')
  @NoStore()
  @ApiOperation({
    summary: 'The compound’s buildings',
    description: 'As its units name them.',
  })
  @ApiOkResponse({ type: [String] })
  buildings(): Promise<string[]> {
    return this.reps.buildings();
  }

  @Get('candidates')
  @NoStore()
  @ApiOperation({
    summary: 'Who may represent a building',
    description:
      'The active owners of a unit in it, by name, with their units there.',
  })
  @ApiOkResponse({ type: [GovernanceOwnerView] })
  async candidates(
    @Query() q: RepresentativeCandidatesQueryDto,
  ): Promise<GovernanceOwnerView[]> {
    return (await this.reps.candidates(q.building)).map((o) =>
      GovernanceOwnerView.from(o),
    );
  }
}

/**
 * Naming or ending a building's representative, the board's matters
 * (ADR 0059), decided by its motions (ADR 0055).
 */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/representatives/matters')
export class BoardRepresentativeMattersController {
  constructor(
    private readonly reps: RepresentativesService,
    private readonly motions: MotionsService,
  ) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Raise a matter about a building’s representative',
    description:
      'A sitting member (BOARD_SEAT_REQUIRED). `appoint` names an owner of a unit in the building (REPRESENTATIVE_NOT_AN_OWNER, REPRESENTATIVE_ALREADY_SITTING); `end` names a sitting term (REPRESENTATIVE_ENDED). One pending per building (REPRESENTATIVE_MATTER_PENDING). The board decides it by a carried motion; an approval applies it at once.',
  })
  @ApiCreatedResponse({ type: BoardRepresentativeMatterView })
  async raise(
    @Body() dto: RaiseRepresentativeMatterDto,
  ): Promise<BoardRepresentativeMatterView> {
    return BoardRepresentativeMatterView.fromBoard(await this.reps.raise(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'The board’s matters, newest first' })
  @ApiOkResponse({ type: ListOf(RepresentativeMatterView) })
  async list(
    @Query() q: RepresentativeMattersQueryDto,
  ): Promise<ListResponse<RepresentativeMatterView>> {
    return toList(await this.reps.matters(q), (m) =>
      RepresentativeMatterView.from(m),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read a matter with the board’s motions' })
  @ApiOkResponse({ type: BoardRepresentativeMatterView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<BoardRepresentativeMatterView> {
    return BoardRepresentativeMatterView.fromBoard(await this.reps.matter(id));
  }

  @Post(':id/motions')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Propose a motion on a matter',
    description:
      'Approve or reject, with the reasons. One open motion per matter (BOARD_MOTION_OPEN); whom it names is recused (BOARD_MEMBER_RECUSED); the other members are told.',
  })
  @ApiCreatedResponse({ type: BoardMotionView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: ProposeRepresentativeMotionDto,
  ): Promise<BoardMotionView> {
    return BoardMotionView.from(
      await this.motions.propose('representative', id, dto),
    );
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Withdraw a pending matter',
    description:
      'Its raiser, still sitting (REPRESENTATIVE_MATTER_NOT_YOURS, BOARD_MATTER_DECIDED); its open motion closes with it.',
  })
  @ApiOkResponse({ type: BoardRepresentativeMatterView })
  async withdraw(
    @Param('id', parseId()) id: string,
  ): Promise<BoardRepresentativeMatterView> {
    return BoardRepresentativeMatterView.fromBoard(
      await this.reps.withdrawMatter(id),
    );
  }
}

/** Building representatives, the management's view (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance/representatives')
export class StaffRepresentativesController {
  constructor(private readonly reps: RepresentativesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The buildings’ representatives',
    description: 'Who represents which building; never their threads.',
  })
  @ApiOkResponse({ type: [RepresentativeView] })
  async list(): Promise<RepresentativeView[]> {
    return (await this.reps.list()).map((r) => RepresentativeView.from(r));
  }
}

/** A building's residents and their representative (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('units.read')
@Controller('me/representatives')
export class ResidentRepresentativesController {
  constructor(private readonly reps: RepresentativesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The representatives of the caller’s buildings',
    description: 'Their first name and since when.',
  })
  @ApiOkResponse({ type: [BuildingRepresentativeView] })
  async list(): Promise<BuildingRepresentativeView[]> {
    return (await this.reps.mine()).map((r) =>
      BuildingRepresentativeView.from(r),
    );
  }

  @Get(':id/messages')
  @NoStore()
  @ApiOperation({
    summary: 'The caller’s conversation with a representative',
    description: 'Oldest first; empty before the first message.',
  })
  @ApiOkResponse({ type: ListOf(RepresentativeMessageView) })
  async messages(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<RepresentativeMessageView>> {
    return toList(await this.reps.myMessages(id, q), (m) =>
      RepresentativeMessageView.from(m),
    );
  }

  @Post(':id/messages')
  @NoStore()
  @ApiOperation({
    summary: 'Write to the building’s representative',
    description:
      'A resident of the building (REPRESENTATIVE_NOT_FOUND otherwise), while the term lasts (REPRESENTATIVE_ENDED). The representative sees the caller’s unit and first name.',
  })
  @ApiCreatedResponse({ type: RepresentativeMessageView })
  async write(
    @Param('id', parseId()) id: string,
    @Body() dto: RepresentativeMessageDto,
  ): Promise<RepresentativeMessageView> {
    return RepresentativeMessageView.from(await this.reps.write(id, dto.body));
  }
}

/** The representative's side of their threads (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('governance.read')
@Controller('me/representation/threads')
export class RepresentationController {
  constructor(private readonly reps: RepresentativesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The conversations written to the caller as a representative',
    description: 'Latest first: each writer’s unit and first name.',
  })
  @ApiOkResponse({ type: ListOf(RepresentativeThreadView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<RepresentativeThreadView>> {
    return toList(await this.reps.threads(q), (t) =>
      RepresentativeThreadView.from(t),
    );
  }

  @Get(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'A conversation’s messages, oldest first' })
  @ApiOkResponse({ type: ListOf(RepresentativeMessageView) })
  async messages(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<RepresentativeMessageView>> {
    return toList(await this.reps.threadMessages(id, q), (m) =>
      RepresentativeMessageView.from(m),
    );
  }

  @Post(':id/messages')
  @NoStore()
  @ApiOperation({
    summary: 'Answer a resident',
    description: 'While the term lasts (REPRESENTATIVE_ENDED).',
  })
  @ApiCreatedResponse({ type: RepresentativeMessageView })
  async reply(
    @Param('id', parseId()) id: string,
    @Body() dto: RepresentativeMessageDto,
  ): Promise<RepresentativeMessageView> {
    return RepresentativeMessageView.from(await this.reps.reply(id, dto.body));
  }
}
