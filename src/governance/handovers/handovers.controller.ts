import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
} from '@nestjs/swagger';
import type { BoardHandoverPack, ManagerHandover } from '@prisma/client';
import { IsString, Length, ValidateIf } from 'class-validator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  HANDOVER_LIMITS,
  HANDOVER_STATUSES,
  HandoversService,
} from './handovers.service';

const pdf = (name: string, body: Buffer) =>
  new StreamableFile(body, {
    type: 'application/pdf',
    disposition: `attachment; filename="${name}"`,
  });

export class SaveHandoverDto {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: HANDOVER_LIMITS.notes,
    description:
      'The outgoing manager’s notes to whoever comes next; null clears them. Write no resident’s name.',
  })
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Length(
    1,
    HANDOVER_LIMITS.notes,
    withParams({ min: 1, max: HANDOVER_LIMITS.notes }),
  )
  notes: string | null;
}

export class BoardHandoverPackView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  termId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  previousTermId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt: Date;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'What the board before left open when this one started to sit: requests, appeals, objections, proposals and action items by reference, the latest minutes, and the domains’ sections (contracts ending, the active budget). Codes, days and amounts; never a name.',
  })
  contents: Record<string, unknown>;

  static from(p: BoardHandoverPack): BoardHandoverPackView {
    return {
      id: p.id,
      termId: p.termId,
      previousTermId: p.previousTermId,
      generatedAt: p.generatedAt,
      contents: p.contents as Record<string, unknown>,
    };
  }
}

export class ManagerHandoverView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ enum: HANDOVER_STATUSES, enumName: 'ManagerHandoverStatus' })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when none were written, or once its writer was erased.',
  })
  notes: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'What waited for the office when it was delivered; null for a draft.',
  })
  contents: Record<string, unknown> | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deliveredAt: Date | null;

  static from(
    h: ManagerHandover,
    fullName: string | null,
  ): ManagerHandoverView {
    return {
      id: h.id,
      accountId: h.accountId,
      fullName,
      status: h.status,
      notes: h.notes,
      contents: (h.contents as Record<string, unknown> | null) ?? null,
      createdAt: h.createdAt,
      deliveredAt: h.deliveredAt,
    };
  }
}

export class MyHandoverView {
  @ApiProperty({
    type: ManagerHandoverView,
    nullable: true,
    description: 'The caller’s draft, or else their latest delivered one.',
  })
  handover: ManagerHandoverView | null;
}

/** The board's handover pack (ADR 0075). */
@ApiArea('governance')
@RequireAnyPermission('governance.board', 'governance.manage')
@Controller('board/handover-pack')
export class BoardHandoverPackController {
  constructor(private readonly handovers: HandoversService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The sitting board’s handover pack',
    description:
      'Written once, when the board started to sit (BOARD_HANDOVER_PACK_NOT_FOUND for a board that started before, or none sitting).',
  })
  @ApiOkResponse({ type: BoardHandoverPackView })
  async get(): Promise<BoardHandoverPackView> {
    return BoardHandoverPackView.from(await this.handovers.sittingPack());
  }

  @Get('pdf')
  @NoStore()
  @ApiOperation({ summary: 'The sitting board’s handover pack as a PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async pdf(): Promise<StreamableFile> {
    const { name, body } = await this.handovers.packPdf();
    return pdf(name, body);
  }
}

/** A manager's own handover (ADR 0075). */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance/handover')
export class MyHandoverController {
  constructor(private readonly handovers: HandoversService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'The caller’s handover' })
  @ApiOkResponse({ type: MyHandoverView })
  async mine(): Promise<MyHandoverView> {
    const h = await this.handovers.mine();
    if (!h) return { handover: null };
    const names = await this.handovers.names([h]);
    return {
      handover: ManagerHandoverView.from(h, names.get(h.accountId) ?? null),
    };
  }

  @Put()
  @NoStore()
  @ApiOperation({
    summary: 'Write the caller’s handover notes',
    description: 'A new draft when none is open.',
  })
  @ApiOkResponse({ type: ManagerHandoverView })
  async save(@Body() dto: SaveHandoverDto): Promise<ManagerHandoverView> {
    const h = await this.handovers.saveDraft(dto);
    return ManagerHandoverView.from(
      h,
      (await this.handovers.names([h])).get(h.accountId) ?? null,
    );
  }

  @Post('deliver')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Deliver the caller’s handover',
    description:
      'Once, with a snapshot of what waits for the office now (MANAGER_HANDOVER_NOT_FOUND with no draft). The sitting board and the other managers are told. From then on the account may be deactivated; until then, while a board sits, HANDOVER_PENDING, unless the board approved going without (`manager_handover_override`).',
  })
  @ApiOkResponse({ type: ManagerHandoverView })
  async deliver(): Promise<ManagerHandoverView> {
    const h = await this.handovers.deliver();
    return ManagerHandoverView.from(
      h,
      (await this.handovers.names([h])).get(h.accountId) ?? null,
    );
  }
}

/** Delivered handovers: the board and the managers read them (ADR 0075). */
@ApiArea('governance')
@RequireAnyPermission('governance.board', 'governance.manage')
@Controller('board/manager-handovers')
export class ManagerHandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Delivered manager handovers, latest first' })
  @ApiOkResponse({ type: ListOf(ManagerHandoverView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ManagerHandoverView>> {
    const page = await this.handovers.delivered(q);
    const names = await this.handovers.names(page.items);
    return toList(page, (h) =>
      ManagerHandoverView.from(h, names.get(h.accountId) ?? null),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read a delivered handover' })
  @ApiOkResponse({ type: ManagerHandoverView })
  async get(@Param('id', parseId()) id: string): Promise<ManagerHandoverView> {
    const h = await this.handovers.getDelivered(id);
    return ManagerHandoverView.from(
      h,
      (await this.handovers.names([h])).get(h.accountId) ?? null,
    );
  }

  @Get(':id/pdf')
  @NoStore()
  @ApiOperation({ summary: 'A delivered handover as a PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async pdf(@Param('id', parseId()) id: string): Promise<StreamableFile> {
    const { name, body } = await this.handovers.handoverPdf(id);
    return pdf(name, body);
  }
}
