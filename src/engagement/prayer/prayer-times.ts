import {
  CalculationMethod,
  Coordinates,
  Madhab,
  PrayerTimes,
  type CalculationParameters,
} from 'adhan';
import type { LocalDate } from '../../core/common/slots/day-slots';

/** The calculation methods a compound may choose (the CHECK repeats them). */
export const PRAYER_METHODS = [
  'egyptian',
  'muslim_world_league',
  'umm_al_qura',
  'karachi',
  'dubai',
  'qatar',
  'kuwait',
] as const;
export type PrayerMethod = (typeof PRAYER_METHODS)[number];
export const ASR_MADHABS = ['shafi', 'hanafi'] as const;
export type AsrMadhab = (typeof ASR_MADHABS)[number];

const METHODS: Record<PrayerMethod, () => CalculationParameters> = {
  egyptian: () => CalculationMethod.Egyptian(),
  muslim_world_league: () => CalculationMethod.MuslimWorldLeague(),
  umm_al_qura: () => CalculationMethod.UmmAlQura(),
  karachi: () => CalculationMethod.Karachi(),
  dubai: () => CalculationMethod.Dubai(),
  qatar: () => CalculationMethod.Qatar(),
  kuwait: () => CalculationMethod.Kuwait(),
};

export interface PrayerDay {
  fajr: Date;
  sunrise: Date;
  dhuhr: Date;
  asr: Date;
  maghrib: Date;
  isha: Date;
}

/**
 * A day's prayer times at a place (ADR 0071), computed with `adhan`. The
 * day is the compound's local day: adhan reads the year, month and day of
 * the date it is given in the runtime's own zone, so the date is built
 * from those three numbers there, whatever that zone is. The answers are
 * instants.
 */
export function prayerTimes(
  on: LocalDate,
  place: { latitude: number; longitude: number },
  method: PrayerMethod,
  madhab: AsrMadhab,
): PrayerDay {
  const [y, m, d] = on.split('-').map(Number);
  const params = METHODS[method]();
  params.madhab = madhab === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi;
  const t = new PrayerTimes(
    new Coordinates(place.latitude, place.longitude),
    new Date(y, m - 1, d),
    params,
  );
  return {
    fajr: t.fajr,
    sunrise: t.sunrise,
    dhuhr: t.dhuhr,
    asr: t.asr,
    maghrib: t.maghrib,
    isha: t.isha,
  };
}
