import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getRoot() {
    return { name: 'jiwar-community-backend', status: 'ok' };
  }
}
