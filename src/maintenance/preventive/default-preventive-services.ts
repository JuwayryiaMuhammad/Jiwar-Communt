export interface DefaultPreventiveService {
  key: string;
  nameAr: string;
  nameEn: string;
  /** The key of the category whose technicians do it. */
  categoryKey: string;
  position: number;
}

/**
 * The check-ups a new compound's residents may book (ADR 0038). They are
 * the compound's own data from then on: the manager renames, reorders,
 * retires or adds.
 *
 * The migration 20261014090700_preventive_services backfills existing
 * compounds with the same list; a unit test keeps the two in step.
 */
export const DEFAULT_PREVENTIVE_SERVICES: readonly DefaultPreventiveService[] =
  [
    {
      key: 'ac_service',
      nameAr: 'صيانة التكييف',
      nameEn: 'AC service',
      categoryKey: 'ac',
      position: 1,
    },
    {
      key: 'water_heater',
      nameAr: 'فحص السخان',
      nameEn: 'Water heater',
      categoryKey: 'plumbing',
      position: 2,
    },
    {
      key: 'plumbing_check',
      nameAr: 'فحص السباكة',
      nameEn: 'Plumbing check',
      categoryKey: 'plumbing',
      position: 3,
    },
    {
      key: 'electrical_check',
      nameAr: 'فحص الكهرباء',
      nameEn: 'Electrical check',
      categoryKey: 'electrical',
      position: 4,
    },
  ];
