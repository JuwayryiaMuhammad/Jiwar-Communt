import { parseCsv } from '../../core/common/csv-parse';
import {
  checkAssetSheet,
  referencedCodes,
  type ImportLookups,
} from './asset-import-rules';

const sheet = (s: string) => parseCsv(Buffer.from(s, 'utf8'));
const lookups: ImportLookups = {
  types: new Map([['pump', 'type-pump']]),
  units: new Map([['A-101', 'unit-a101']]),
  areas: new Map([['ROOF', 'area-roof']]),
  existing: new Map([
    [
      'OLD-1',
      {
        id: 'asset-old',
        depth: 1,
        unitId: null,
        commonAreaId: 'area-roof',
        retired: false,
      },
    ],
    [
      'GONE',
      {
        id: 'asset-gone',
        depth: 1,
        unitId: null,
        commonAreaId: 'area-roof',
        retired: true,
      },
    ],
    [
      'DEEP',
      {
        id: 'asset-deep',
        depth: 4,
        unitId: null,
        commonAreaId: 'area-roof',
        retired: false,
      },
    ],
  ]),
  buildings: new Set(['Tower 1']),
};

describe('asset sheets (ADR 0064)', () => {
  it('roots in a unit or an area, parts under an earlier row or the register, inheriting the place', () => {
    const { rows, problems } = checkAssetSheet(
      sheet(
        [
          'code,type,name_ar,name_en,unit,area,parent,commissioned_on,purchase_value,criticality,serves_buildings',
          'P-1,pump,مضخة,Pump 1,,ROOF,,2020-01-31,1500.50,high,Tower 1',
          'P-1a,pump,محرك,Motor,,,P-1,,,,',
          'U-1,pump,مضخة,Unit pump,A-101,,,,,,',
          'O-1a,pump,جزء,Part,,,OLD-1,,,,',
        ].join('\n'),
      ),
      lookups,
    );
    expect(problems).toEqual([]);
    expect(
      rows.map((r) => [r.code, r.depth, r.unitId, r.commonAreaId, r.parent]),
    ).toEqual([
      ['P-1', 1, null, 'area-roof', null],
      ['P-1a', 2, null, 'area-roof', { rowCode: 'P-1' }],
      ['U-1', 1, 'unit-a101', null, null],
      ['O-1a', 2, null, 'area-roof', { existingId: 'asset-old' }],
    ]);
    expect(rows[0].facts).toMatchObject({
      commissionedOn: '2020-01-31',
      purchaseValue: '1500.50',
      criticality: 'high',
      servesBuildings: ['Tower 1'],
    });
  });

  it('every problem with its line and column, never the text; no row when any', () => {
    const { rows, problems } = checkAssetSheet(
      sheet(
        [
          'code,type,name_ar,name_en,unit,area,parent,commissioned_on,purchase_value,expected_life_years,criticality,vendor_phone,serves_buildings',
          'bad code,boiler,,X,A-999,,,2026-02-30,12.345,0,urgent,call me,Tower 9',
          'OLD-1,pump,a,b,A-101,ROOF,,,,,,,',
          'C-1,pump,a,b,,,GONE,,,,,,',
          'C-2,pump,a,b,,,DEEP,,,,,,',
          'C-3,pump,a,b,,,,,,,,,',
          'C-3,pump,a,b,A-101,,,,,,,,',
          'C-4,pump,a,b,A-101,,,,,,,,',
          'C-4,pump,a,b,A-101,,,,,,,,',
        ].join('\n'),
      ),
      lookups,
    );
    expect(rows).toEqual([]);
    expect(problems).toEqual([
      { line: 2, field: 'code', code: 'INVALID_FORMAT' },
      { line: 2, field: 'type', code: 'ASSET_TYPE_NOT_AVAILABLE' },
      { line: 2, field: 'name_ar', code: 'FIELD_REQUIRED' },
      { line: 2, field: 'vendor_phone', code: 'INVALID_FORMAT' },
      { line: 2, field: 'purchase_value', code: 'INVALID_FORMAT' },
      { line: 2, field: 'commissioned_on', code: 'INVALID_FORMAT' },
      { line: 2, field: 'expected_life_years', code: 'INVALID_NUMBER' },
      { line: 2, field: 'criticality', code: 'INVALID_VALUE' },
      { line: 2, field: 'serves_buildings', code: 'BUILDING_NOT_FOUND' },
      { line: 2, field: 'unit', code: 'UNIT_NOT_AVAILABLE' },
      { line: 3, field: 'code', code: 'DUPLICATE_VALUE' },
      { line: 3, field: 'area', code: 'FIELD_NOT_ALLOWED' },
      { line: 4, field: 'parent', code: 'PARENT_NOT_AVAILABLE' },
      { line: 5, field: 'parent', code: 'ASSET_TOO_DEEP' },
      { line: 6, field: 'unit', code: 'FIELD_REQUIRED' },
      // C-3's first row failed, so its second is not a duplicate of it.
      { line: 9, field: 'code', code: 'DUPLICATE_VALUE' },
    ]);
  });

  it('a header problem stops there: unknown and missing columns', () => {
    expect(
      checkAssetSheet(sheet('code,type,name_ar,colour\n1,2,3,4'), lookups)
        .problems,
    ).toEqual([
      { line: 1, field: 'colour', code: 'FIELD_NOT_ALLOWED' },
      { line: 1, field: 'name_en', code: 'FIELD_REQUIRED' },
    ]);
  });

  it('the codes a sheet refers to, each once', () => {
    expect(
      referencedCodes(
        sheet(
          'code,type,name_ar,name_en,unit,parent,serves_buildings\nA,t,x,y,U1,,T1; T2\nB,t,x,y,,A,T1',
        ),
      ),
    ).toEqual({
      assets: ['A', 'B'],
      units: ['U1'],
      areas: [],
      buildings: ['T1', 'T2'],
    });
  });
});
