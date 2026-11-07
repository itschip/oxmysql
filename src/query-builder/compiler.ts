import {
  DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler,
  expressionBuilder, sql, type Compilable, type Expression, type IdentifierNode, type SqlBool,
} from 'kysely';
import type { CompiledQuery } from './types';

// Preserve literal identifier parts instead of Kysely parsing " as " or trimming
// qualified names. Kysely still owns all quoting, placeholders, and SQL generation.
class LiteralMysqlCompiler extends MysqlQueryCompiler {
  identifiers?: Record<string, readonly string[]>;

  protected override visitIdentifier(node: IdentifierNode): void {
    const parts = this.identifiers?.[node.name];
    if (!parts) return super.visitIdentifier(node);
    for (let i = 0; i < parts.length; i++) {
      if (i) this.append('.');
      super.visitIdentifier({ ...node, name: parts[i] });
    }
  }
}

type Database = Record<string, Record<string, unknown>>;
const compiler = new LiteralMysqlCompiler();
// One cold instance: no Kysely pool or database driver is created or executed.
const client = new Kysely<Database>({
  dialect: {
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new MysqlIntrospector(db),
    createQueryCompiler: () => compiler,
  },
});
const eb = expressionBuilder<Database, string>();

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

export function compileQuery(input: unknown): CompiledQuery {
  const spec = record(input, null, 'statement');
  const identifiers: Record<string, readonly string[]> = Object.create(null);
  let nextIdentifier = 0;
  const name = (parts: readonly string[]): string => {
    const token = `i${nextIdentifier++}`;
    identifiers[token] = parts;
    return token;
  };
  const part = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || /[.*?\u0000-\u001f\u007f]/.test(value))
      throw new Error('queryBuilder: identifier segments must be non-empty and cannot contain dots, wildcards, placeholders, or control characters.');
    return value;
  };
  const scalar = (value: unknown): string | boolean | number => {
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
      throw new Error('queryBuilder: values must be non-null strings, booleans, or finite numbers.');
    return value;
  };

  const identifier = (input: unknown): string => {
    const value = record(input, ['kind', 'parts'], 'identifier');
    if (value.kind !== 'identifier') throw new Error('queryBuilder: expected identifier kind.');

    return name(array(value.parts, 'identifier parts').map(part));
  };

  const column = (value: unknown): string => name([part(value)]);

  const predicate = (input: unknown, depth = 0): Expression<SqlBool> => {
    if (depth >= 64) throw new Error('queryBuilder: predicate nesting exceeds 64 levels.');
    const value = record(input, ['kind', 'operator', 'column', 'value', 'values', 'predicates'], 'predicate');

    switch (value.kind) {
      case 'comparison': {
        record(value, ['kind', 'operator', 'column', 'value'], 'comparison');
        if (value.operator !== 'eq') throw new Error('queryBuilder: unsupported comparison operator.');
        return eb(identifier(value.column), '=', scalar(value.value));
      }
      case 'collection': {
        record(value, ['kind', 'operator', 'column', 'values'], 'collection');
        if (value.operator !== 'inArray') throw new Error('queryBuilder: unsupported collection operator.');
        const column = identifier(value.column);
        const values = array(value.values, 'inArray values', true).map(scalar);
        return values.length ? eb(column, 'in', values) : sql<SqlBool>`1 = 0`;
      }
      case 'group': {
        record(value, ['kind', 'operator', 'predicates'], 'group');
        if (value.operator !== 'allOf') throw new Error('queryBuilder: unsupported group operator.');
        const children = array(value.predicates, 'allOf predicates');
        return eb.and(children.map((child) => predicate(child, depth + 1)));
      }
      default:
        throw new Error('queryBuilder: unsupported predicate kind.');
    }
  };

  const valuesMap = (input: unknown): { values: Record<string, unknown>; keys: string[] } => {
    const values = record(input, null, 'values');
    const keys = Object.keys(values).sort();
    if (!keys.length || keys.length !== Reflect.ownKeys(values).length)
      throw new Error('queryBuilder: values must be a non-empty map with enumerable column names.');
    return { values, keys };
  };

  let query: Compilable;
  switch (spec.kind) {
    case 'select': {
      record(spec, ['kind', 'from', 'columns', 'where', 'limit'], 'select');
      const columns = spec.columns === '*' ? null : array(spec.columns, 'select columns').map(identifier);
      const from = client.selectFrom(identifier(spec.from));
      let select = columns === null ? from.selectAll() : from.select(columns);
      if (Object.hasOwn(spec, 'where')) select = select.where(predicate(spec.where));
      if (Object.hasOwn(spec, 'limit')) {
        if (typeof spec.limit !== 'number' || !Number.isSafeInteger(spec.limit) || spec.limit < 0)
          throw new Error('queryBuilder: limit must be a non-negative safe integer.');
        select = select.limit(spec.limit);
      }
      query = select;
      break;
    }
    case 'insert': {
      record(spec, ['kind', 'into', 'rows'], 'insert');
      const table = identifier(spec.into);
      const rows = array(spec.rows, 'insert rows').map(valuesMap);
      const { keys } = rows[0];
      const columns = keys.map(column);
      query = client.insertInto(table).values(rows.map((row) => {
        if (row.keys.length !== keys.length || row.keys.some((key, index) => key !== keys[index]))
          throw new Error('queryBuilder: insert rows must have the same column names.');
        const values: Record<string, unknown> = Object.create(null);
        for (let i = 0; i < keys.length; i++) values[columns[i]] = scalar(row.values[keys[i]]);
        return values;
      }));
      break;
    }
    case 'update': {
      record(spec, ['kind', 'table', 'values', 'where', 'allowAll'], 'update');
      if (Object.hasOwn(spec, 'allowAll') && typeof spec.allowAll !== 'boolean')
        throw new Error('queryBuilder: allowAll must be a boolean.');
      if (!Object.hasOwn(spec, 'where') && spec.allowAll !== true)
        throw new Error('queryBuilder: update requires a predicate or allowAll().');
      const table = identifier(spec.table);
      const { values, keys } = valuesMap(spec.values);
      const updates: Record<string, unknown> = Object.create(null);
      for (const key of keys) updates[column(key)] = scalar(values[key]);
      let update = client.updateTable(table).set(updates);
      if (Object.hasOwn(spec, 'where')) update = update.where(predicate(spec.where));
      query = update;
      break;
    }
    default:
      throw new Error('queryBuilder: unsupported statement kind; expected select, insert, or update.');
  }

  // Compilation is synchronous; the shared compiler never retains per-query names.
  compiler.identifiers = identifiers;
  try {
    const { sql, parameters } = query.compile();
    return { sql, parameters: parameters as unknown[] };
  } finally {
    compiler.identifiers = undefined;
  }
}
