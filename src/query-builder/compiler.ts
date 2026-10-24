import type { QueryDialect } from './dialect';
import type { CompiledQuery } from './types';

function record(value: unknown, fields: readonly string[] | null, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`queryBuilder: ${label} must be a plain object.`);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`queryBuilder: ${label} must be a plain object.`);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (fields && !fields.includes(key)) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))
      throw new Error(`queryBuilder: unsupported ${label} field.`);
  }

  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || Object.keys(value).length !== value.length)
    throw new Error(`queryBuilder: ${label} must be a ${allowEmpty ? '' : 'non-empty '}dense array.`);

  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error(`queryBuilder: ${label} must be a dense array.`);
  }

  return value;
}

export function compileQuery(input: unknown, dialect: QueryDialect): CompiledQuery {
  const spec = record(input, null, 'statement');

  const parameters: unknown[] = [];
  const bind = (value: unknown): string => {
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
      throw new Error('queryBuilder: values must be non-null strings, booleans, or finite numbers.');

    parameters.push(value);
    return dialect.placeholder(parameters.length);
  };

  const identifier = (input: unknown): string => {
    const value = record(input, ['kind', 'parts'], 'identifier');
    if (value.kind !== 'identifier') throw new Error('queryBuilder: expected identifier kind.');

    return array(value.parts, 'identifier parts').map((part) => {
      if (typeof part !== 'string' || !part.trim() || /[.*?\u0000-\u001f\u007f]/.test(part))
        throw new Error('queryBuilder: identifier segments must be non-empty and cannot contain dots, wildcards, placeholders, or control characters.');

      return dialect.quoteIdentifierPart(part);
    }).join('.');
  };

  const predicate = (input: unknown, depth = 0): string => {
    if (depth >= 64) throw new Error('queryBuilder: predicate nesting exceeds 64 levels.');
    const value = record(input, ['kind', 'operator', 'column', 'value', 'values', 'predicates'], 'predicate');

    switch (value.kind) {
      case 'comparison': {
        record(value, ['kind', 'operator', 'column', 'value'], 'comparison');
        if (value.operator !== 'eq') throw new Error('queryBuilder: unsupported comparison operator.');
        return `${identifier(value.column)} = ${bind(value.value)}`;
      }
      case 'collection': {
        record(value, ['kind', 'operator', 'column', 'values'], 'collection');
        if (value.operator !== 'inArray') throw new Error('queryBuilder: unsupported collection operator.');
        const column = identifier(value.column);
        const values = array(value.values, 'inArray values', true);
        return values.length ? `${column} IN (${values.map(bind).join(', ')})` : '1 = 0';
      }
      case 'group': {
        record(value, ['kind', 'operator', 'predicates'], 'group');
        if (value.operator !== 'allOf') throw new Error('queryBuilder: unsupported group operator.');
        return `(${array(value.predicates, 'allOf predicates').map((child) => predicate(child, depth + 1)).join(' AND ')})`;
      }
      default:
        throw new Error('queryBuilder: unsupported predicate kind.');
    }
  };

  const valuesMap = (input: unknown): { values: Record<string, unknown>; keys: string[]; columns: string[] } => {
    const values = record(input, null, 'values');
    const keys = Object.keys(values).sort();
    if (!keys.length || keys.length !== Reflect.ownKeys(values).length)
      throw new Error('queryBuilder: values must be a non-empty map with enumerable column names.');
    const columns = keys.map((key) => identifier({ kind: 'identifier', parts: [key] }));
    return { values, keys, columns };
  };

  let sql: string;
  switch (spec.kind) {
    case 'select': {
      record(spec, ['kind', 'from', 'columns', 'where', 'limit'], 'select');
      const columns = spec.columns === '*' ? '*' : array(spec.columns, 'select columns').map(identifier).join(', ');
      sql = `SELECT ${columns} FROM ${identifier(spec.from)}`;
      if (Object.hasOwn(spec, 'where')) sql += ` WHERE ${predicate(spec.where)}`;
      if (Object.hasOwn(spec, 'limit')) {
        if (typeof spec.limit !== 'number' || !Number.isSafeInteger(spec.limit) || spec.limit < 0)
          throw new Error('queryBuilder: limit must be a non-negative safe integer.');
        sql += ` LIMIT ${bind(spec.limit)}`;
      }
      break;
    }
    case 'insert': {
      record(spec, ['kind', 'into', 'rows'], 'insert');
      const table = identifier(spec.into);
      const rows = array(spec.rows, 'insert rows').map(valuesMap);
      const { keys, columns } = rows[0];
      const tuples = rows.map((row) => {
        if (row.keys.length !== keys.length || row.keys.some((key, index) => key !== keys[index]))
          throw new Error('queryBuilder: insert rows must have the same column names.');
        return `(${keys.map((key) => bind(row.values[key])).join(', ')})`;
      });
      sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`;
      break;
    }
    case 'update': {
      record(spec, ['kind', 'table', 'values', 'where', 'allowAll'], 'update');
      if (Object.hasOwn(spec, 'allowAll') && typeof spec.allowAll !== 'boolean')
        throw new Error('queryBuilder: allowAll must be a boolean.');
      if (!Object.hasOwn(spec, 'where') && spec.allowAll !== true)
        throw new Error('queryBuilder: update requires a predicate or allowAll().');
      const table = identifier(spec.table);
      const { values, keys, columns } = valuesMap(spec.values);
      sql = `UPDATE ${table} SET ${keys.map((key, index) => `${columns[index]} = ${bind(values[key])}`).join(', ')}`;
      if (Object.hasOwn(spec, 'where')) sql += ` WHERE ${predicate(spec.where)}`;
      break;
    }
    default:
      throw new Error('queryBuilder: unsupported statement kind; expected select, insert, or update.');
  }

  return { sql, parameters };
}
