import { Controller, Get } from '@nestjs/common';
import { Public } from './common/guards/public.decorator';

@Public()
@Controller()
export class AppController {
  @Get()
  getRoot() {
    return { name: 'jiwar-community-backend', status: 'ok' };
  }
}
