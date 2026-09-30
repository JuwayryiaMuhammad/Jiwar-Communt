import { Controller, Get } from '@nestjs/common';
import { ApiArea } from './core/common/http/decorators';
import { Public } from './core/common/guards/public.decorator';

@ApiArea('health', 'public')
@Public()
@Controller()
export class AppController {
  @Get()
  getRoot() {
    return { name: 'jiwar-community-backend', status: 'ok' };
  }
}
