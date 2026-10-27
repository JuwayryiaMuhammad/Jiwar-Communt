import type { ParsedCsv } from '../../core/common/csv-parse';
import { FieldErrorCode } from '../../core/common/errors';
import { isRealDate } from '../schedules/local-dates';
import {
  ASSET_CODE,
  ASSET_CONDITIONS,
  ASSET_CRITICALITIES,
  ASSET_NAME,
  ASSET_TEXT,
  LIFE_YEARS,
  MAX_DEPTH,
  MAX_SERVED_BUILDINGS,
  MONEY,
  VENDOR_PHONE,
  type AssetCondition,
  type AssetCriticality,
} from './asset-rules';
import type { AssetFacts } from './assets.service';

/**
 * An asset sheet (ADR 0064): one row per asset, a header naming the
 * columns. A root names its `unit` (code) or its `area` (code); a part
 * names its `parent` (an asset's code, already in the register or on an
 * earlier row) and goes where it is. Empty cells are absent;
 * `serves_buildings` is `;`-separated.
 */
export const REQUIRED_COLUMNS = ['code', 'type', 'name_ar', 'name_en'] as const;
export const OPTIONAL_COLUMNS = [
  'unit',
  'area',
  'parent',
  'manufacturer',
  'model',
  'serial_number',
  'commissioned_on',
  'purchase_value',
  'replacement_cost',
  'downtime_cost_per_day',
  'expected_life_years',
  'vendor_name',
  'vendor_phone',
  'warranty_ends_on',
  'criticality',
  'condition',
  'serves_buildings',
] as const;
const COLUMNS: readonly string[] = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

/** Problems an import keeps; the count goes on. */
export const MAX_IMPORT_PROBLEMS = 100;

/** A problem: where and what, never the cell's text. */
export interface ImportProblem {
  line: number;
  field: string;
  code: string;
}

/** What a sheet's rows are checked against, read under the import's locks. */
export interface ImportLookups {
  /** Active types by key. */
  types: ReadonlyMap<string, string>;
  /** Units by code. */
  units: ReadonlyMap<string, string>;
  /** Active common areas by code. */
  areas: ReadonlyMap<string, string>;
  /** Assets already in the register, by code. */
  existing: ReadonlyMap<
    string,
    {
      id: string;
      depth: number;
      unitId: string | null;
      commonAreaId: string | null;
      retired: boolean;
    }
  >;
  /** The buildings the sheet names that some unit is in. */
  buildings: ReadonlySet<string>;
}

export interface ImportRow {
  line: number;
  code: string;
  typeId: string;
  /** An asset in the register, or an earlier row by its code. */
  parent: { existingId: string } | { rowCode: string } | null;
  unitId: string | null;
  commonAreaId: string | null;
  depth: number;
  facts: AssetFacts;
}

/** The codes a sheet refers to, to read its lookups by. */
export function referencedCodes(sheet: ParsedCsv): {
  assets: string[];
  units: string[];
  areas: string[];
  buildings: string[];
} {
  const col = (name: string) => sheet.header.indexOf(name);
  const values = (name: string) =>
    col(name) < 0
      ? []
      : sheet.rows
          .map((r) => r.cells[col(name)].trim())
          .filter((v) => v !== '');
  return {
    assets: [...new Set([...values('code'), ...values('parent')])],
    units: [...new Set(values('unit'))],
    areas: [...new Set(values('area'))],
    buildings: [
      ...new Set(
        values('serves_buildings').flatMap((v) =>
          v
            .split(';')
            .map((b) => b.trim())
            .filter((b) => b !== ''),
        ),
      ),
    ],
  };
}

/**
 * Checks a whole sheet; rows come out in sheet order (a part after its
 * parent) only when there is no problem at all.
 */
export function checkAssetSheet(
  sheet: ParsedCsv,
  l: ImportLookups,
): { rows: ImportRow[]; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  for (const name of sheet.header)
    if (!COLUMNS.includes(name))
      problems.push({
        line: 1,
        field: name,
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
  for (const name of REQUIRED_COLUMNS)
    if (!sheet.header.includes(name))
      problems.push({
        line: 1,
        field: name,
        code: FieldErrorCode.FIELD_REQUIRED,
      });
  if (problems.length) return { rows: [], problems };

  const rows: ImportRow[] = [];
  /** Rows so far by code: depth and place, for the parts below them. */
  const earlier = new Map<
    string,
    { depth: number; unitId: string | null; commonAreaId: string | null }
  >();
  for (const { line, cells } of sheet.rows) {
    const get = (name: string): string | undefined => {
      const i = sheet.header.indexOf(name);
      const v = i < 0 ? '' : cells[i].trim();
      return v === '' ? undefined : v;
    };
    const fail = (field: string, code: string) =>
      problems.push({ line, field, code });
    const before = problems.length;

    const code = get('code');
    if (code === undefined) fail('code', FieldErrorCode.FIELD_REQUIRED);
    else if (!ASSET_CODE.test(code))
      fail('code', FieldErrorCode.INVALID_FORMAT);
    else if (earlier.has(code) || l.existing.has(code))
      fail('code', FieldErrorCode.DUPLICATE_VALUE);

    const typeKey = get('type');
    const typeId = typeKey === undefined ? undefined : l.types.get(typeKey);
    if (typeKey === undefined) fail('type', FieldErrorCode.FIELD_REQUIRED);
    else if (typeId === undefined)
      fail('type', FieldErrorCode.ASSET_TYPE_NOT_AVAILABLE);

    const text = (
      name: string,
      limits: { min: number; max: number },
      required = false,
    ) => {
      const v = get(name);
      if (v === undefined) {
        if (required) fail(name, FieldErrorCode.FIELD_REQUIRED);
        return null;
      }
      if (v.length < limits.min || v.length > limits.max)
        fail(name, FieldErrorCode.INVALID_LENGTH);
      return v;
    };
    const nameAr = text('name_ar', ASSET_NAME, true);
    const nameEn = text('name_en', ASSET_NAME, true);
    const manufacturer = text('manufacturer', ASSET_TEXT);
    const model = text('model', ASSET_TEXT);
    const serialNumber = text('serial_number', ASSET_TEXT);
    const vendorName = text('vendor_name', ASSET_TEXT);
    const pattern = (name: string, re: RegExp) => {
      const v = get(name);
      if (v !== undefined && !re.test(v))
        fail(name, FieldErrorCode.INVALID_FORMAT);
      return v ?? null;
    };
    const vendorPhone = pattern('vendor_phone', VENDOR_PHONE);
    const purchaseValue = pattern('purchase_value', MONEY);
    const replacementCost = pattern('replacement_cost', MONEY);
    const downtimeCostPerDay = pattern('downtime_cost_per_day', MONEY);
    const date = (name: string) => {
      const v = get(name);
      if (v !== undefined && !isRealDate(v))
        fail(name, FieldErrorCode.INVALID_FORMAT);
      return v ?? null;
    };
    const commissionedOn = date('commissioned_on');
    const warrantyEndsOn = date('warranty_ends_on');
    const lifeCell = get('expected_life_years');
    const life = lifeCell === undefined ? null : Number(lifeCell);
    if (
      life !== null &&
      (!/^\d{1,3}$/.test(lifeCell!) ||
        life < LIFE_YEARS.min ||
        life > LIFE_YEARS.max)
    )
      fail('expected_life_years', FieldErrorCode.INVALID_NUMBER);
    const oneOf = <T extends string>(
      name: string,
      list: readonly T[],
    ): T | undefined => {
      const v = get(name);
      if (v !== undefined && !(list as readonly string[]).includes(v))
        fail(name, FieldErrorCode.INVALID_VALUE);
      return v as T | undefined;
    };
    const criticality = oneOf<AssetCriticality>(
      'criticality',
      ASSET_CRITICALITIES,
    );
    const condition = oneOf<AssetCondition>('condition', ASSET_CONDITIONS);
    const served = (get('serves_buildings') ?? '')
      .split(';')
      .map((b) => b.trim())
      .filter((b) => b !== '');
    if (served.length > MAX_SERVED_BUILDINGS)
      fail('serves_buildings', FieldErrorCode.INVALID_VALUE);
    else if (served.some((b) => !l.buildings.has(b)))
      fail('serves_buildings', FieldErrorCode.BUILDING_NOT_FOUND);

    // The place: a parent, or a unit or an area.
    const unitCode = get('unit');
    const areaCode = get('area');
    const parentCode = get('parent');
    let parent: ImportRow['parent'] = null;
    let depth = 1;
    let unitId: string | null = null;
    let commonAreaId: string | null = null;
    if (parentCode !== undefined) {
      if (unitCode !== undefined)
        fail('unit', FieldErrorCode.FIELD_NOT_ALLOWED);
      if (areaCode !== undefined)
        fail('area', FieldErrorCode.FIELD_NOT_ALLOWED);
      const row = earlier.get(parentCode);
      const known = l.existing.get(parentCode);
      const found = row ?? (known && !known.retired ? known : undefined);
      if (!found) fail('parent', FieldErrorCode.PARENT_NOT_AVAILABLE);
      else if (found.depth >= MAX_DEPTH)
        fail('parent', FieldErrorCode.ASSET_TOO_DEEP);
      else {
        parent = row ? { rowCode: parentCode } : { existingId: known!.id };
        depth = found.depth + 1;
        unitId = found.unitId;
        commonAreaId = found.commonAreaId;
      }
    } else if (unitCode !== undefined && areaCode !== undefined) {
      fail('area', FieldErrorCode.FIELD_NOT_ALLOWED);
    } else if (unitCode !== undefined) {
      unitId = l.units.get(unitCode) ?? null;
      if (unitId === null) fail('unit', FieldErrorCode.UNIT_NOT_AVAILABLE);
    } else if (areaCode !== undefined) {
      commonAreaId = l.areas.get(areaCode) ?? null;
      if (commonAreaId === null)
        fail('area', FieldErrorCode.COMMON_AREA_NOT_AVAILABLE);
    } else fail('unit', FieldErrorCode.FIELD_REQUIRED);

    if (problems.length > before || code === undefined || typeId === undefined)
      continue;
    earlier.set(code, { depth, unitId, commonAreaId });
    rows.push({
      line,
      code,
      typeId,
      parent,
      unitId,
      commonAreaId,
      depth,
      facts: {
        nameAr: nameAr!,
        nameEn: nameEn!,
        manufacturer,
        model,
        serialNumber,
        commissionedOn,
        purchaseValue,
        replacementCost,
        downtimeCostPerDay,
        expectedLifeYears: life,
        vendorName,
        vendorPhone,
        warrantyEndsOn,
        ...(criticality ? { criticality } : {}),
        ...(condition ? { condition } : {}),
        servesBuildings: served,
      },
    });
  }
  return problems.length ? { rows: [], problems } : { rows, problems };
}
