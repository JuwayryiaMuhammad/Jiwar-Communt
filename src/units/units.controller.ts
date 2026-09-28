import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/roles.decorator';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UnitView } from './dto/unit.view';
import { UnitsService } from './units.service';

@ApiTags('units')
@ApiBearerAuth()
@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  list(): Promise<UnitView[]> {
    return this.units.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UnitView> {
    return this.units.get(id);
  }

  @Roles('manager')
  @Post()
  create(@Body() dto: CreateUnitDto): Promise<UnitView> {
    return this.units.create(dto);
  }
}
