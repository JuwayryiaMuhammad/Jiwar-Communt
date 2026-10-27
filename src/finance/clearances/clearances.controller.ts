import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
} from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { Public } from '../../core/common/guards/public.decorator';
import {
  ApiArea,
  NoStore,
  PublicPageHeaders,
} from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { ClearancePageService } from './clearance-page.service';
import {
  ClearancesService,
  type ClearanceRead,
  type PublicClearance,
} from './clearances.service';

/** A clearance certificate (ADR 0062). */
export class ClearanceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: '`CL-` and the number.' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  asOf: Date;
  @ApiProperty({ type: String, format: 'date' })
  validUntil: string;
  @ApiProperty({
    type: String,
    description: 'Anyone checks it with this code on the public page.',
  })
  verifyCode: string;

  static from(c: ClearanceRead): ClearanceView {
    return { ...c };
  }
}

export class PublicClearanceView {
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({ type: String })
  number: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  asOf: Date;
  @ApiProperty({ type: String, format: 'date' })
  validUntil: string;
  @ApiProperty({ enum: ['valid', 'expired'] })
  status: 'valid' | 'expired';

  static from(c: PublicClearance): PublicClearanceView {
    return { ...c };
  }
}

export class ClearanceCodeDto {
  @ApiProperty({
    type: String,
    description: 'The 22 characters on the certificate.',
  })
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  code: string;
}

const pdf = (name: string, body: Buffer) =>
  new StreamableFile(body, {
    type: 'application/pdf',
    disposition: `attachment; filename="${name}"`,
  });

/** A resident's clearances: asked by an active occupant, never a delegate. */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class ClearancesController {
  constructor(private readonly clearances: ClearancesService) {}

  /** Anything owed, open disputes included, is CLEARANCE_BALANCE_DUE with the amount. */
  @Post('units/:unitId/clearances')
  @ApiOperation({ summary: 'Ask for a clearance certificate' })
  @NoStore()
  @ApiCreatedResponse({ type: ClearanceView })
  async ask(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ClearanceView> {
    return ClearanceView.from(await this.clearances.ask(unitId));
  }

  @Get('units/:unitId/clearances')
  @ApiOperation({ summary: 'My clearance certificates for the unit' })
  @NoStore()
  @ApiOkResponse({ type: [ClearanceView] })
  async mine(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ClearanceView[]> {
    return (await this.clearances.mine(unitId)).map((c) =>
      ClearanceView.from(c),
    );
  }

  @Get('clearances/:id/certificate')
  @ApiOperation({ summary: 'A clearance certificate as a PDF' })
  @NoStore()
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async certificate(
    @Param('id', parseId()) id: string,
  ): Promise<StreamableFile> {
    const { name, body } = await this.clearances.certificate(id, false);
    return pdf(name, body);
  }
}

/** Clearances, the management's side (`finance.invoice`). */
@ApiArea('finance')
@RequirePermissions('finance.invoice')
@Controller('staff')
export class StaffClearancesController {
  constructor(private readonly clearances: ClearancesService) {}

  @Post('units/:unitId/clearances')
  @ApiOperation({ summary: 'Issue a clearance certificate for a unit' })
  @NoStore()
  @ApiCreatedResponse({ type: ClearanceView })
  async issue(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ClearanceView> {
    return ClearanceView.from(await this.clearances.staffIssue(unitId));
  }

  @Get('clearances/:id/certificate')
  @ApiOperation({ summary: 'A clearance certificate as a PDF' })
  @NoStore()
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async certificate(
    @Param('id', parseId()) id: string,
  ): Promise<StreamableFile> {
    const { name, body } = await this.clearances.certificate(id, true);
    return pdf(name, body);
  }
}

/** Anyone checks a clearance by its code (ADR 0062), as a receipt is checked. */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/clearances')
export class PublicClearancesController {
  constructor(private readonly page: ClearancePageService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check a clearance certificate by its code' })
  @ApiOkResponse({ type: PublicClearanceView })
  async lookup(
    @Body() dto: ClearanceCodeDto,
    @Ip() ip: string,
  ): Promise<PublicClearanceView> {
    return PublicClearanceView.from(await this.page.lookup(dto.code, ip));
  }
}
