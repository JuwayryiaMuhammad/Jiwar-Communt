import { Global, Module } from '@nestjs/common';
import { WorksCompletions } from './works-completions';
import { WorksDeposits } from './works-deposits';

/**
 * A unit's works completion (ADR 0063): the gate registers its reader. A
 * works permit's deposit (ADR 0074): finance implements it, the gate
 * registers its readers.
 */
@Global()
@Module({
  providers: [WorksCompletions, WorksDeposits],
  exports: [WorksCompletions, WorksDeposits],
})
export class WorksCompletionsModule {}
