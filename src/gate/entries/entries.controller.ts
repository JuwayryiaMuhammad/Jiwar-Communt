import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
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

  /** Read-only (apart from the rate limit): no Idempotency-Key. */
  @RequirePermissions('gate.operate')
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VerifyView })
  async verify(@Body() dto: VerifyDto): Promise<VerifyView> {
    return VerifyView.from(await this.verifier.verify(dto));
  }

  @RequirePermissions('gate.operate')
  @Post('entries')
  @Idempotent()
  @ApiCreatedResponse({ type: EntryView })
  async record(@Body() dto: RecordEntryDto): Promise<EntryView> {
    return EntryView.from(await this.entries.record(dto));
  }

  @RequirePermissions('gate.read')
  @Get('entries')
  @ApiOkResponse({ type: ListOf(EntryListView) })
  async list(
    @Query() q: EntriesQueryDto,
  ): Promise<ListResponse<EntryListView>> {
    return toList(await this.entries.list(q), (e) => EntryListView.from(e));
  }

  /** Who is inside now: an entry with no exit yet. */
  @RequirePermissions('gate.operate')
  @Get('inside')
  @ApiOkResponse({ type: ListOf(InsideView) })
  async inside(@Query() q: PageQueryDto): Promise<ListResponse<InsideView>> {
    return toList(await this.entries.inside(q), (i) => InsideView.from(i));
  }
}
