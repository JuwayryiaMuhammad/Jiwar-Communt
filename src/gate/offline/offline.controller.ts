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
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { DeviceEnvelopeDto } from './dto/device-envelope.dto';
import {
  OfflineFlagsQueryDto,
  ReviewOfflineFlagDto,
} from './dto/offline-flags.dto';
import { OfflineFlags } from './offline-flags.service';
import { OfflineUploadsService } from './offline-uploads.service';
import {
  OfflineFlagResponse,
  OfflineUploadResponse,
} from './views/offline.views';

/** A device uploads what it recorded offline (ADR 0057). */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate/offline')
export class GuardOfflineController {
  constructor(private readonly uploads: OfflineUploadsService) {}

  @Post('uploads')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload a batch of what this device recorded offline',
    description:
      'A signed envelope (`purpose: upload`, `batchId`, `actions`: 1 to 100 in sequence). Any guard of the compound may upload it, on duty or not: each action is the guard’s, shift’s and gate’s of its bundle. A retry answers the same; each action is recorded at its device time and flagged where the server knows more. A signature that does not verify refuses the batch whole (GATE_DEVICE_SIGNATURE_INVALID), audited and told.',
  })
  @ApiOkResponse({ type: OfflineUploadResponse })
  async upload(@Body() dto: DeviceEnvelopeDto): Promise<OfflineUploadResponse> {
    return OfflineUploadResponse.from(await this.uploads.upload(dto));
  }
}

/** The management reads and reviews the offline flags (ADR 0057). */
@ApiArea('gate')
@RequirePermissions('gate_devices.manage')
@Controller('staff/gate/offline')
export class StaffOfflineController {
  constructor(private readonly flags: OfflineFlags) {}

  @Get('flags')
  @NoStore()
  @ApiOperation({ summary: 'List the offline flags, newest first' })
  @ApiOkResponse({ type: ListOf(OfflineFlagResponse) })
  async list(
    @Query() q: OfflineFlagsQueryDto,
  ): Promise<ListResponse<OfflineFlagResponse>> {
    return toList(await this.flags.list(q), (v) => OfflineFlagResponse.from(v));
  }

  @Get('flags/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get an offline flag' })
  @ApiOkResponse({ type: OfflineFlagResponse })
  async get(@Param('id', parseId()) id: string): Promise<OfflineFlagResponse> {
    return OfflineFlagResponse.from(await this.flags.get(id));
  }

  @Post('flags/:id/review')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Review an offline flag, once',
    description:
      'With a code from `offlineFlagReview` (GATE_OFFLINE_FLAG_REVIEWED after).',
  })
  @ApiOkResponse({ type: OfflineFlagResponse })
  async review(
    @Param('id', parseId()) id: string,
    @Body() dto: ReviewOfflineFlagDto,
  ): Promise<OfflineFlagResponse> {
    return OfflineFlagResponse.from(
      await this.flags.review(id, dto.reviewCode),
    );
  }
}
