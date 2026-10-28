import { Global, Module } from '@nestjs/common';
import { MoveSteps } from './move-steps';

/** A move's derived steps (ADR 0063): the domains register their readers. */
@Global()
@Module({ providers: [MoveSteps], exports: [MoveSteps] })
export class MoveStepsModule {}
