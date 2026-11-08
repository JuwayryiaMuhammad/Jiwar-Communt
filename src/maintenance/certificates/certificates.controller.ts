import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CertificatesService } from './certificates.service';
import {
  CreateStaffCertificateDto,
  StaffCertificatesQueryDto,
  UpdateStaffCertificateDto,
} from './dto/certificates.dto';
import { StaffCertificateView } from './views/certificate.views';

/** The staff's certificates, kept by the field team (ADR 0090). */
@ApiArea('field-team')
@RequirePermissions('field_team.manage')
@Controller('staff/field-team/certificates')
export class StaffCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the staff certificates',
    description:
      'The live ones (or the removed, `removed=true`), soonest expiry first, 500 at most; without their papers’ links.',
  })
  @ApiOkResponse({ type: ListOf(StaffCertificateView) })
  async list(
    @Query() q: StaffCertificatesQueryDto,
  ): Promise<ListResponse<StaffCertificateView>> {
    return bounded(
      await this.certificates.list({
        accountId: q.accountId,
        state: q.state,
        removed: q.removed === 'true',
      }),
      (r) => StaffCertificateView.from(r),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Add a staff certificate',
    description:
      'For an active staff member, with the day it expires and its paper when filed. Warn only: its holder and the field team are told 30 days ahead and on the day; an expired one blocks no assignment and no work.',
  })
  @ApiCreatedResponse({ type: StaffCertificateView })
  async create(
    @Body() dto: CreateStaffCertificateDto,
  ): Promise<StaffCertificateView> {
    return StaffCertificateView.from(await this.certificates.create(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a staff certificate, with its paper' })
  @ApiOkResponse({ type: StaffCertificateView })
  async get(@Param('id', parseId()) id: string): Promise<StaffCertificateView> {
    return StaffCertificateView.from(await this.certificates.get(id));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Change or renew a staff certificate',
    description:
      'Its words, its days, its paper (replaced, or removed with null). A new expiry is a renewal: its notices start again.',
  })
  @ApiOkResponse({ type: StaffCertificateView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateStaffCertificateDto,
  ): Promise<StaffCertificateView> {
    return StaffCertificateView.from(await this.certificates.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a staff certificate',
    description:
      'Once (filed by mistake, or no longer held): its paper goes, the record stays.',
  })
  @ApiNoContentResponse()
  remove(@Param('id', parseId()) id: string): Promise<void> {
    return this.certificates.remove(id);
  }
}

/** A staff member's own certificates (ADR 0090), with no permission. */
@ApiArea('field-team')
@Controller('staff/my-certificates')
export class MyCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List my certificates',
    description: 'My live ones, soonest expiry first, with their papers.',
  })
  @ApiOkResponse({ type: ListOf(StaffCertificateView) })
  async mine(): Promise<ListResponse<StaffCertificateView>> {
    return bounded(await this.certificates.mine(), (r) =>
      StaffCertificateView.from(r),
    );
  }
}
