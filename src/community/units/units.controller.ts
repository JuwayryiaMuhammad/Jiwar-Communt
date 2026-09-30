import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UnitView } from './dto/unit.view';
import { UnitsService } from './units.service';

@ApiArea('units')
@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @RequirePermissions('units.read')
  @Get()
  list(): Promise<UnitView[]> {
    return this.units.list();
  }

  @RequirePermissions('units.read')
  @Get(':id')
  get(@Param('id', parseId()) id: string): Promise<UnitView> {
    return this.units.get(id);
  }

  @RequirePermissions('units.create')
  @Post()
  create(@Body() dto: CreateUnitDto): Promise<UnitView> {
    return this.units.create(dto);
  }
}
