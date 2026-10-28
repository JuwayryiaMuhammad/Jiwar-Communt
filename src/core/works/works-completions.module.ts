import { Global, Module } from '@nestjs/common';
import { WorksCompletions } from './works-completions';

/** A unit's works completion (ADR 0063): the gate registers its reader. */
@Global()
@Module({ providers: [WorksCompletions], exports: [WorksCompletions] })
export class WorksCompletionsModule {}
