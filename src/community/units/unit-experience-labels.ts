import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExperienceSources } from '../../core/experience/experience-sources';

/**
 * The units as experience and recovery lists them (ADR 0082): a unit's code
 * and its building's name, never its people.
 */
@Injectable()
export class UnitExperienceLabels implements OnModuleInit {
  constructor(private readonly sources: ExperienceSources) {}

  onModuleInit(): void {
    this.sources.registerUnits(async (tx, unitIds) => {
      const rows = await tx.unit.findMany({
        where: { id: { in: [...unitIds] } },
        select: { id: true, code: true, building: true },
      });
      return new Map(
        rows.map((u) => [u.id, { code: u.code, building: u.building }]),
      );
    });
  }
}
