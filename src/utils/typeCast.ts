import type { TypeCastField, TypeCastNext } from 'mysql2/promise';

const BINARY_CHARSET = 63;
type FieldWithMetadata = TypeCastField & { charset?: number; decimals?: number };

const floatRounding = { useGrouping: false, roundingMode: 'halfEven' } as const;
const floatFormat = new Intl.NumberFormat('en-US', { ...floatRounding, maximumSignificantDigits: 6 });
const fixedScaleFormats: Intl.NumberFormat[] = [];

/**
 * node-mysql2 v3.9.0 introduced (breaking) typecasting for execute methods.
 */
export function typeCastExecute(field: TypeCastField, next: TypeCastNext) {
  switch (field.type) {
    case 'DATETIME':
    case 'DATETIME2':
    case 'TIMESTAMP':
    case 'TIMESTAMP2':
    case 'NEWDATE': {
      const value = field.string();
      return value ? new Date(value).getTime() : null;
    }
    case 'DATE': {
      const value = field.string();
      return value ? new Date(value + ' 00:00:00').getTime() : null;
    }
    default:
      return next();
  }
}

/**
 * mysql-async compatible typecasting.
 */
export function typeCast(field: FieldWithMetadata, next: TypeCastNext) {
  switch (field.type) {
    case 'DATETIME':
    case 'DATETIME2':
    case 'TIMESTAMP':
    case 'TIMESTAMP2':
    case 'NEWDATE': {
      const value = field.string();
      return value ? new Date(value).getTime() : null;
    }
    case 'DATE': {
      const value = field.string();
      return value ? new Date(value + ' 00:00:00').getTime() : null;
    }
    case 'TINY': {
      if (field.length !== 1) return next();

      const value = field.string();

      return value === null ? null : value === '1';
    }
    case 'BIT': {
      const buffer = field.buffer();

      if (!buffer) return null;

      return buffer.length === 1 ? buffer[0] === 1 : buffer[0];
    }
    case 'TINY_BLOB':
    case 'MEDIUM_BLOB':
    case 'LONG_BLOB':
    case 'BLOB':
      if (field.charset === BINARY_CHARSET) {
        const value = field.buffer();
        if (value === null) return [value];
        return [...value];
      }
      return field.string();
    default:
      return next();
  }
}

export function typeCastPreparedQuery(field: FieldWithMetadata, next: TypeCastNext) {
  switch (field.type) {
    case 'FLOAT':
    case 'DOUBLE': {
      const value = next();
      if (typeof value !== 'number') return value;

      // The text protocol rounds fixed-scale columns to their declared scale.
      const { decimals } = field;
      if (decimals === undefined || decimals >= 31) {
        return field.type === 'FLOAT' ? Number(floatFormat.format(value)) : value;
      }
      const format = (fixedScaleFormats[decimals] ??= new Intl.NumberFormat('en-US', {
        ...floatRounding,
        maximumFractionDigits: decimals,
      }));
      return Number(format.format(value));
    }
    case 'VARCHAR':
    case 'VAR_STRING':
    case 'STRING':
    case 'ENUM':
    case 'SET':
      if (field.charset === BINARY_CHARSET) return field.buffer();
  }
  return typeCast(field, next);
}
