import { describe, test, expect, mock } from 'bun:test';
import { typeCast, typeCastExecute, typeCastPreparedQuery } from 'utils/typeCast';

type FieldOpts = {
  type: string;
  length?: number;
  charset?: number;
  decimals?: number;
  string?: () => string | null;
  buffer?: () => Buffer | null;
};

function field(opts: FieldOpts) {
  return {
    type: opts.type,
    length: opts.length ?? 0,
    charset: opts.charset ?? 33, // utf8 by default
    decimals: opts.decimals,
    string: opts.string ?? (() => null),
    buffer: opts.buffer ?? (() => null),
  } as any;
}

const BINARY_CHARSET = 63;

describe('typeCast (text protocol)', () => {
  test('DATETIME/TIMESTAMP become epoch milliseconds', () => {
    const next = mock(() => 'unused');
    const result = typeCast(field({ type: 'DATETIME', string: () => '2024-01-02 03:04:05' }), next);
    expect(result).toBe(new Date('2024-01-02 03:04:05').getTime());
    expect(next).not.toHaveBeenCalled();
  });

  test('a null date returns null', () => {
    expect(typeCast(field({ type: 'TIMESTAMP', string: () => null }), mock(() => 0))).toBeNull();
  });

  test('DATE is anchored to midnight', () => {
    const result = typeCast(field({ type: 'DATE', string: () => '2024-01-02' }), mock(() => 0));
    expect(result).toBe(new Date('2024-01-02 00:00:00').getTime());
  });

  test('TINY(1) maps to a boolean, wider TINY defers to next()', () => {
    expect(typeCast(field({ type: 'TINY', length: 1, string: () => '1' }), mock(() => 0))).toBe(true);
    expect(typeCast(field({ type: 'TINY', length: 1, string: () => '0' }), mock(() => 0))).toBe(false);
    expect(typeCast(field({ type: 'TINY', length: 3, string: () => '7' }), () => 7)).toBe(7);
    expect(typeCast(field({ type: 'TINY', length: 1, string: () => null }), () => null)).toBe(null);
  });

  test('a consumed TINY/BIT field never falls through to next()', () => {
    const tinyNull = mock(() => 'shifted');
    typeCast(field({ type: 'TINY', length: 1, string: () => null }), tinyNull);
    expect(tinyNull).not.toHaveBeenCalled();

    const tinyOther = mock(() => 'shifted');
    typeCast(field({ type: 'TINY', length: 1, string: () => '2' }), tinyOther);
    expect(tinyOther).not.toHaveBeenCalled();

    const bitNull = mock(() => 'shifted');
    typeCast(field({ type: 'BIT', length: 1, buffer: () => null }), bitNull);
    expect(bitNull).not.toHaveBeenCalled();

    const bitWide = mock(() => 'shifted');
    typeCast(field({ type: 'BIT', length: 2, buffer: () => Buffer.from([3, 0]) }), bitWide);
    expect(bitWide).not.toHaveBeenCalled();
  });

  test('BIT(1) maps to a boolean', () => {
    expect(typeCast(field({ type: 'BIT', length: 1, buffer: () => Buffer.from([1]) }), mock(() => 0))).toBe(true);
    expect(typeCast(field({ type: 'BIT', length: 1, buffer: () => Buffer.from([0]) }), mock(() => 0))).toBe(false);
    expect(typeCast(field({ type: 'BIT', length: 1, buffer: () => null }), () => null)).toBe(null);
  });

  test('a binary BLOB becomes a plain number array', () => {
    const result = typeCast(
      field({ type: 'BLOB', charset: BINARY_CHARSET, buffer: () => Buffer.from([1, 2, 3]) }),
      mock(() => 0)
    );
    expect(result).toEqual([1, 2, 3]);
    expect(Array.isArray(result)).toBe(true);
  });

  test('a NULL binary BLOB returns [null]', () => {
    const result = typeCast(field({ type: 'BLOB', charset: BINARY_CHARSET, buffer: () => null }), mock(() => 0));
    expect(result).toEqual([null]);
  });

  test('a non-binary BLOB (text charset) returns its string', () => {
    const result = typeCast(field({ type: 'BLOB', charset: 33, string: () => 'hello' }), mock(() => 0));
    expect(result).toBe('hello');
  });

  test('unknown types defer to next()', () => {
    const next = mock(() => 'defaulted');
    expect(typeCast(field({ type: 'VARCHAR', string: () => 'x' }), next)).toBe('defaulted');
    expect(next).toHaveBeenCalled();
  });
});

describe('typeCastExecute (binary protocol)', () => {
  test('handles dates like the text caster', () => {
    const result = typeCastExecute(field({ type: 'DATETIME', string: () => '2024-01-02 03:04:05' }), mock(() => 0));
    expect(result).toBe(new Date('2024-01-02 03:04:05').getTime());
  });

  test('defers everything else to next() (does not touch BLOBs)', () => {
    const next = mock(() => 'native');
    expect(typeCastExecute(field({ type: 'BLOB', charset: BINARY_CHARSET }), next)).toBe('native');
    expect(next).toHaveBeenCalled();
  });
});

describe('typeCastPreparedQuery', () => {
  test('keeps query booleans and binary value types', () => {
    const next = mock(() => 'unused');
    const bytes = Buffer.from([0, 255]);
    expect(typeCastPreparedQuery(field({ type: 'TINY', length: 1, string: () => '0' }), next)).toBe(false);
    expect(typeCastPreparedQuery(field({ type: 'VAR_STRING', charset: BINARY_CHARSET, buffer: () => bytes }), next)).toBe(bytes);
    expect(typeCastPreparedQuery(field({ type: 'BLOB', charset: BINARY_CHARSET, buffer: () => null }), next)).toEqual([null]);
    expect(next).not.toHaveBeenCalled();
  });

  test('preserves text-protocol FLOAT precision and nulls', () => {
    expect(typeCastPreparedQuery(field({ type: 'FLOAT', decimals: 31 }), () => 123456.5)).toBe(123456);
    expect(typeCastPreparedQuery(field({ type: 'FLOAT', decimals: 4 }), () => Math.fround(1.2346))).toBe(1.2346);
    expect(typeCastPreparedQuery(field({ type: 'FLOAT' }), () => null)).toBeNull();
  });

  test('rounds a fixed-scale DOUBLE to its declared scale', () => {
    const value = -8.900000000311437e-7;
    expect(typeCastPreparedQuery(field({ type: 'DOUBLE', decimals: 8 }), () => value)).toBe(-8.9e-7);
    expect(typeCastPreparedQuery(field({ type: 'DOUBLE', decimals: 31 }), () => value)).toBe(value);
  });
});
