import { Types } from 'mysql2';
import type { ConnectionOptions, FieldPacket, RowDataPacket, TypeCastField, TypeCastNext } from 'mysql2/promise';

const BINARY_CHARSET = 63;
const UNSPECIFIED_SCALE = 31;
type FieldWithCharset = TypeCastField & { charset?: number };

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
export function typeCast(field: FieldWithCharset, next: TypeCastNext) {
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

export function typeCastPreparedQuery(field: FieldWithCharset, next: TypeCastNext) {
  switch (field.type) {
    case 'VARCHAR':
    case 'VAR_STRING':
    case 'STRING':
    case 'ENUM':
    case 'SET':
      if (field.charset === BINARY_CHARSET) return field.buffer();
  }
  return typeCast(field, next);
}

export function roundPreparedNumbers(
  rows: RowDataPacket[],
  fields: FieldPacket[],
  { disableEval, nestTables, rowsAsArray }: Pick<ConnectionOptions, 'disableEval' | 'nestTables' | 'rowsAsArray'>,
) {
  const separator = typeof nestTables === 'string' ? nestTables : undefined;
  const byIndex = rowsAsArray && (disableEval || (separator === undefined && nestTables !== true));
  const byTable = !byIndex && nestTables === true;
  const columnKey = (field: FieldPacket) => separator === undefined ? field.name : field.table + separator + field.name;

  for (const [index, field] of fields.entries()) {
    const { columnType, decimals } = field;
    const fixedScale = decimals < UNSPECIFIED_SCALE;
    if (columnType !== Types.FLOAT && !(columnType === Types.DOUBLE && fixedScale)) continue;

    // With named columns, the driver only keeps the last value for a repeated name.
    const key = byIndex ? index : columnKey(field);
    const isLast = byIndex || fields.findLastIndex((other) =>
      (!byTable || other.table === field.table) && columnKey(other) === key,
    ) === index;
    if (!isLast) continue;

    const format = fixedScale
      ? (fixedScaleFormats[decimals] ??= new Intl.NumberFormat('en-US', {
        ...floatRounding,
        maximumFractionDigits: decimals,
      }))
      : floatFormat;
    for (const row of rows) {
      const columns = byTable ? row[field.table] : row;
      const value = columns?.[key];
      if (typeof value === 'number') columns[key] = Number(format.format(value));
    }
  }
}
