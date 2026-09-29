import type { Unit } from '@prisma/client';

export class UnitView {
  id: string;
  code: string;
  building: string | null;
  floor: number | null;
  createdAt: Date;

  static from(unit: Unit): UnitView {
    return {
      id: unit.id,
      code: unit.code,
      building: unit.building,
      floor: unit.floor,
      createdAt: unit.createdAt,
    };
  }
}
