import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { Public } from '../../core/common/guards/public.decorator';
import {
  ApiArea,
  NoStore,
  PublicPageHeaders,
} from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  DecidePermitInspectionDto,
  PermitInspectionsQueryDto,
  WorksCertificateCodeDto,
} from './dto/permit-inspections.dto';
import { PermitInspectionsService } from './permit-inspections.service';
import {
  PermitInspectionView,
  PublicWorksCertificateView,
  StaffPermitInspectionView,
} from './views/permit-inspection.views';
import { WorksCertificatePageService } from './works-certificate-page.service';

const pdf = (name: string, body: Buffer) =>
  new StreamableFile(body, {
    type: 'application/pdf',
    disposition: `attachment; filename="${name}"`,
  });

/** A works permit's completion, its requester's (ADR 0063). */
@ApiArea('permits')
@RequirePermissions('permits.request')
@Controller('permits/:id')
export class PermitInspectionsController {
  constructor(private readonly inspections: PermitInspectionsService) {}

  @Post('completion-inspection')
  @ApiOperation({ summary: 'Ask for the finished works to be inspected' })
  @ApiCreatedResponse({ type: PermitInspectionView })
  async ask(@Param('id', parseId()) id: string): Promise<PermitInspectionView> {
    return PermitInspectionView.from(await this.inspections.ask(id));
  }

  @Get('completion-inspections')
  @ApiOperation({ summary: 'The permit’s completion inspections' })
  @ApiOkResponse({ type: [PermitInspectionView] })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<PermitInspectionView[]> {
    return (await this.inspections.mine(id)).map((i) =>
      PermitInspectionView.from(i),
    );
  }

  @Get('completion-certificate')
  @NoStore()
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'The works completion certificate as a PDF' })
  @ApiOkResponse({ description: 'The PDF.' })
  async certificate(
    @Param('id', parseId()) id: string,
  ): Promise<StreamableFile> {
    const { name, body } = await this.inspections.certificate(id);
    return pdf(name, body);
  }
}

/** Completion inspections to decide (ADR 0063). */
@ApiArea('permits')
@RequirePermissions('permits.manage')
@Controller('staff/permit-inspections')
export class StaffPermitInspectionsController {
  constructor(private readonly inspections: PermitInspectionsService) {}

  @Get()
  @ApiOperation({ summary: 'Completion inspections, asked by default' })
  @ApiOkResponse({ type: [StaffPermitInspectionView] })
  async queue(
    @Query() q: PermitInspectionsQueryDto,
  ): Promise<StaffPermitInspectionView[]> {
    return (await this.inspections.queue(q.status)).map((i) =>
      StaffPermitInspectionView.fromStaff(i),
    );
  }

  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pass or fail a completion inspection, with photos',
  })
  @ApiOkResponse({ type: PermitInspectionView })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecidePermitInspectionDto,
  ): Promise<PermitInspectionView> {
    return PermitInspectionView.from(await this.inspections.decide(id, dto));
  }

  @Get(':id/certificate')
  @NoStore()
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'A works completion certificate as a PDF' })
  @ApiOkResponse({ description: 'The PDF.' })
  async certificate(
    @Param('id', parseId()) id: string,
  ): Promise<StreamableFile> {
    const { name, body } = await this.inspections.staffCertificate(id);
    return pdf(name, body);
  }
}

/** Anyone checks a works certificate by its code (ADR 0063). */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/works-certificates')
export class PublicWorksCertificatesController {
  constructor(private readonly page: WorksCertificatePageService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check a works completion certificate by its code' })
  @ApiOkResponse({ type: PublicWorksCertificateView })
  async lookup(
    @Body() dto: WorksCertificateCodeDto,
    @Ip() ip: string,
  ): Promise<PublicWorksCertificateView> {
    return PublicWorksCertificateView.from(
      await this.page.lookup(dto.code, ip),
    );
  }
}
