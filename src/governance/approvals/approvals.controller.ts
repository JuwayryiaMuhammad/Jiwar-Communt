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
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ProposeApprovalMotionDto } from '../motions/dto/motions.dto';
import { MotionsService } from '../motions/motions.service';
import { BoardMotionView } from '../motions/views/motions.views';
import { ApprovalsService } from './approvals.service';
import {
  ApprovalsQueryDto,
  ApprovalProgressDto,
  ImplementedApprovalDto,
  RaiseApprovalDto,
} from './dto/approvals.dto';
import { ApprovalView, BoardApprovalView } from './views/approvals.views';

const listQuery = (q: ApprovalsQueryDto) => ({
  ...q,
  overdue: q.overdue === 'true',
});

/** Decision packages for the board, the staff's side (ADR 0055). */
@ApiArea('governance')
@Controller('staff/governance/approvals')
export class StaffApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  @RequirePermissions('governance.approvals')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Put a decision package to the board',
    description:
      'The sitting board is told. Its deadline is the type’s, from the settings. An annual budget is a draft budget of finance’s (it is then submitted, its total the cost); an increase names a line of the active budget.',
  })
  @ApiCreatedResponse({ type: ApprovalView })
  async raise(@Body() dto: RaiseApprovalDto): Promise<ApprovalView> {
    return ApprovalView.from(await this.approvals.raise(dto));
  }

  @Get()
  @RequirePermissions('governance.approvals')
  @NoStore()
  @ApiOperation({
    summary: 'List the requests put to the board',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(ApprovalView) })
  async list(
    @Query() q: ApprovalsQueryDto,
  ): Promise<ListResponse<ApprovalView>> {
    return toList(await this.approvals.list(listQuery(q)), (r) =>
      ApprovalView.from(r),
    );
  }

  @Get(':id')
  @RequirePermissions('governance.approvals')
  @NoStore()
  @ApiOperation({
    summary: 'Read a request',
    description:
      'The package, where it stands, and the board’s decision with its reasons. Never the board’s motions or votes.',
  })
  @ApiOkResponse({ type: ApprovalView })
  async get(@Param('id', parseId()) id: string): Promise<ApprovalView> {
    return ApprovalView.from(await this.approvals.get(id));
  }

  @Post(':id/withdraw')
  @RequireAnyPermission('governance.approvals', 'governance.manage')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Withdraw a pending request',
    description:
      'Who raised it, or the manager (APPROVAL_NOT_YOURS). Its open motion closes; a budget submitted with it is withdrawn too (final: draft another).',
  })
  @ApiOkResponse({ type: ApprovalView })
  async withdraw(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<ApprovalView> {
    return ApprovalView.from(await this.approvals.withdraw(id, dto.reasonCode));
  }

  @Post(':id/implemented')
  @RequirePermissions('governance.manage')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Mark an approved request implemented',
    description: 'Once; the board is told.',
  })
  @ApiOkResponse({ type: ApprovalView })
  async implemented(
    @Param('id', parseId()) id: string,
    @Body() dto: ImplementedApprovalDto,
  ): Promise<ApprovalView> {
    return ApprovalView.from(await this.approvals.implemented(id, dto.note));
  }

  @Post(':id/progress')
  @RequirePermissions('governance.manage')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Record how an approved request is followed up',
    description:
      'In progress as often as it moves; then once implemented (the mark, as `implemented`) or not implementable — final (APPROVAL_PROGRESS_FINAL). The owners reading the decision the board published see it.',
  })
  @ApiOkResponse({ type: ApprovalView })
  async progress(
    @Param('id', parseId()) id: string,
    @Body() dto: ApprovalProgressDto,
  ): Promise<ApprovalView> {
    return ApprovalView.from(await this.approvals.progress(id, dto));
  }
}

/** The board's inbox of requests, and its motions on them (ADR 0055). */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/approvals')
export class BoardApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly motions: MotionsService,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The board’s requests',
    description:
      'What awaits the board (`status=pending`), what waits to be implemented (`approved`), and the rest. A sitting member only.',
  })
  @ApiOkResponse({ type: ListOf(ApprovalView) })
  async list(
    @Query() q: ApprovalsQueryDto,
  ): Promise<ListResponse<ApprovalView>> {
    return toList(await this.approvals.list(listQuery(q)), (r) =>
      ApprovalView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Read a request with its subject and the board’s motions',
  })
  @ApiOkResponse({ type: BoardApprovalView })
  async get(@Param('id', parseId()) id: string): Promise<BoardApprovalView> {
    return BoardApprovalView.fromBoard(await this.approvals.boardGet(id));
  }

  @Post(':id/motions')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Propose a motion on a request',
    description:
      'Approve or reject, with the reasons. One open motion per request (BOARD_MOTION_OPEN); the other members are told.',
  })
  @ApiCreatedResponse({ type: BoardMotionView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: ProposeApprovalMotionDto,
  ): Promise<BoardMotionView> {
    return BoardMotionView.from(
      await this.motions.propose('approval', id, dto),
    );
  }
}
