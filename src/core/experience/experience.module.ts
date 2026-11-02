import {
  Global,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CompensationCredits } from './compensation-credits';
import { CompensationsService } from './compensations.service';
import { ExperienceCasesService } from './experience-cases.service';
import { ExperienceInboxItems } from './experience-inbox-items';
import { ExperienceReportsService } from './experience-reports.service';
import { ExperienceSettingsService } from './experience-settings.service';
import { ExperienceSignalsService } from './experience-signals.service';
import { ExperienceSources } from './experience-sources';
import {
  CompensationDecisionsController,
  ExperienceController,
} from './experience.controller';
import { ServicePromisesService } from './service-promises.service';

/** Every source the rules read is registered, and finance credits. */
@Injectable()
class ExperienceBootstrap implements OnApplicationBootstrap {
  constructor(private readonly sources: ExperienceSources) {}

  onApplicationBootstrap(): void {
    const missing = this.sources.missing();
    if (missing.length)
      throw new Error(`Experience sources missing: ${missing.join(', ')}`);
  }
}

/**
 * Experience and recovery (ADR 0082). Global: the domains register their
 * ratings, events, measures and units with ExperienceSources, and finance
 * implements CompensationCredits, at startup.
 */
@Global()
@Module({
  controllers: [ExperienceController, CompensationDecisionsController],
  providers: [
    ExperienceSources,
    CompensationCredits,
    ExperienceSettingsService,
    ExperienceCasesService,
    ExperienceSignalsService,
    CompensationsService,
    ServicePromisesService,
    ExperienceReportsService,
    ExperienceInboxItems,
    ExperienceBootstrap,
  ],
  exports: [ExperienceSources, CompensationCredits],
})
export class ExperienceModule {}
