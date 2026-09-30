import { Global, Module } from '@nestjs/common';
import { SweepRunner } from './sweep-runner';

/** The in-app sweep; domains register their tasks with SweepRunner. */
@Global()
@Module({
  providers: [SweepRunner],
  exports: [SweepRunner],
})
export class SweepModule {}
