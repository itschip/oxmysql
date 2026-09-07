import type { QueryDialect } from './dialect';
import type { CompiledQuery } from './types';

function record(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`queryBuilder: ${label} must be a plain object.`);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`queryBuilder: ${label} must be a plain object.`);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))
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
  const spec = record(input, ['kind', 'from', 'columns', 'where', 'limit'], 'select');
  if (spec.kind !== 'select') throw new Error('queryBuilder: unsupported statement kind; expected select.');

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

  const columns = spec.columns === '*' ? '*' : array(spec.columns, 'select columns').map(identifier).join(', ');
  let sql = `SELECT ${columns} FROM ${identifier(spec.from)}`;

  if (Object.hasOwn(spec, 'where')) sql += ` WHERE ${predicate(spec.where)}`;
  if (Object.hasOwn(spec, 'limit')) {
    if (typeof spec.limit !== 'number' || !Number.isSafeInteger(spec.limit) || spec.limit < 0)
      throw new Error('queryBuilder: limit must be a non-negative safe integer.');

    sql += ` LIMIT ${bind(spec.limit)}`;
  }

  return { sql, parameters };
}