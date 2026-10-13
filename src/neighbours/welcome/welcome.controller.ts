import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import type { NeighbourWelcomeTemplate } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  hasText,
  textsOf,
  WELCOME_FIELDS,
  WelcomeTemplateService,
} from './welcome-template.service';

const MAX = Object.fromEntries(WELCOME_FIELDS.map((f) => [f.name, f.max]));

/** One optional text of the welcome: absent keeps it, null clears it. */
function Text(
  name: 'rules' | 'officeHours' | 'emergency',
  description: string,
) {
  const range = { min: 1, max: MAX[name] };
  return (target: object, key: string) => {
    ApiProperty({
      type: String,
      required: false,
      nullable: true,
      minLength: range.min,
      maxLength: range.max,
      description,
    })(target, key);
    IsOptional()(target, key);
    IsString()(target, key);
    Length(range.min, range.max, withParams(range))(target, key);
  };
}

export class UpdateWelcomeTemplateDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False: no household is greeted.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @Text('rules', 'The compound’s rules, in English.')
  rulesEn?: string | null;
  @Text('officeHours', 'The office hours, in English.')
  officeHoursEn?: string | null;
  @Text('emergency', 'The emergency numbers, in English.')
  emergencyEn?: string | null;
  @Text('rules', 'The compound’s rules, in Arabic.')
  rulesAr?: string | null;
  @Text('officeHours', 'The office hours, in Arabic.')
  officeHoursAr?: string | null;
  @Text('emergency', 'The emergency numbers, in Arabic.')
  emergencyAr?: string | null;
}

/** The welcome text: written by the compound, in the language it was written in. */
export class WelcomeTextsView {
  @ApiProperty({ type: String, nullable: true })
  rulesEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  officeHoursEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  emergencyEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  rulesAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  officeHoursAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  emergencyAr: string | null;
}

export class WelcomeTemplateView extends WelcomeTextsView {
  @ApiProperty({ type: Boolean, description: 'New households are greeted.' })
  enabled: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(t: NeighbourWelcomeTemplate): WelcomeTemplateView {
    return { enabled: t.enabled, ...textsOf(t), updatedAt: t.updatedAt };
  }
}

/** What a resident reads: the text, or nothing when there is none to show. */
export class WelcomeView extends WelcomeTextsView {
  @ApiProperty({
    type: Boolean,
    description:
      'False: the compound has no welcome to show; every text is null.',
  })
  available: boolean;

  static from(t: NeighbourWelcomeTemplate): WelcomeView {
    const texts = textsOf(t);
    const available = t.enabled && hasText(texts);
    return available
      ? { available, ...texts }
      : {
          available,
          rulesEn: null,
          officeHoursEn: null,
          emergencyEn: null,
          rulesAr: null,
          officeHoursAr: null,
          emergencyAr: null,
        };
  }
}

/** The compound's welcome text, for the manager (ADR 0042). */
@ApiArea('neighbours')
@RequirePermissions('neighbours.manage')
@Controller('neighbours/welcome-template')
export class WelcomeTemplateController {
  constructor(private readonly template: WelcomeTemplateService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the welcome template' })
  @ApiOkResponse({ type: WelcomeTemplateView })
  async get(): Promise<WelcomeTemplateView> {
    return WelcomeTemplateView.from(await this.template.get());
  }

  @Put()
  @NoStore()
  @ApiOperation({ summary: 'Write the welcome template, or turn it off' })
  @ApiOkResponse({ type: WelcomeTemplateView })
  async update(
    @Body() dto: UpdateWelcomeTemplateDto,
  ): Promise<WelcomeTemplateView> {
    return WelcomeTemplateView.from(await this.template.update(dto));
  }
}

/** The welcome as whoever has a unit reads it (ADR 0042). */
@ApiArea('neighbours')
@RequirePermissions('units.read')
@Controller('neighbour-welcome')
export class WelcomeController {
  constructor(private readonly template: WelcomeTemplateService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Read the compound’s welcome' })
  @ApiOkResponse({ type: WelcomeView })
  async get(): Promise<WelcomeView> {
    return WelcomeView.from(await this.template.get());
  }
}
