import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { EntriesQueryDto, RecordEntryDto, VerifyDto } from './dto/entries.dto';
import { EntriesService } from './entries.service';
import { VerifyService } from './verify.service';
import {
  EntryListView,
  EntryView,
  InsideView,
  VerifyView,
} from './views/entry.views';

/** The gate log (ADR 0028). */
@ApiArea('gate')
@Controller('gate')
export class EntriesController {
  constructor(
    private readonly entries: EntriesService,
    private readonly verifier: VerifyService,
  ) {}

  /**
   * Read-only (apart from the rate limit): no Idempotency-Key. No-store: a
   * valid worker's display carries a presigned photo URL (ADR 0029).
   */
  @RequirePermissions('gate.operate')
  @Post('verify')
  @ApiOperation({ summary: 'Verify a code or QR at the gate' })
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VerifyView })
  async verify(@Body() dto: VerifyDto): Promise<VerifyView> {
    return VerifyView.from(await this.verifier.verify(dto));
  }

  @RequirePermissions('gate.operate')
  @Post('entries')
  @ApiOperation({ summary: 'Record an entry or exit' })
  @Idempotent()
  @ApiCreatedResponse({ type: EntryView })
  async record(@Body() dto: RecordEntryDto): Promise<EntryView> {
    return EntryView.from(await this.entries.record(dto));
  }

  @RequirePermissions('gate.read')
  @Get('entries')
  @ApiOperation({ summary: 'Read the gate log' })
  @ApiOkResponse({ type: ListOf(EntryListView) })
  async list(
    @Query() q: EntriesQueryDto,
  ): Promise<ListResponse<EntryListView>> {
    return toList(await this.entries.list(q), (e) => EntryListView.from(e));
  }

  /** Who is inside now: an entry with no exit yet. */
  @RequirePermissions('gate.operate')
  @Get('inside')
  @ApiOperation({ summary: 'List who is inside now' })
  @ApiOkResponse({ type: ListOf(InsideView) })
  async inside(@Query() q: PageQueryDto): Promise<ListResponse<InsideView>> {
    return toList(await this.entries.inside(q), (i) => InsideView.from(i));
  }
}
