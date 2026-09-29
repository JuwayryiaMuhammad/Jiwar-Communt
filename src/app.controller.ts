import { Controller, Get } from '@nestjs/common';
import { Public } from './core/common/guards/public.decorator';

@Public()
@Controller()
export class AppController {
  @Get()
  getRoot() {
    return { name: 'jiwar-community-backend', status: 'ok' };
  }
}
