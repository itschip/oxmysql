import { describe, expect, test } from 'bun:test';
import { compileQuery } from '../../../src/query-builder/compiler';
import { mysqlDialect } from '../../../src/query-builder/dialects/mysql';
import type { Identifier, Predicate, SelectSpec } from '../../../src/query-builder/types';

const id = (...parts: string[]): Identifier => ({ kind: 'identifier', parts });
const eq = (column: string, value: unknown): Predicate => ({ kind: 'comparison', operator: 'eq', column: id(column), value });
const inArray = (values: unknown[]): Predicate => ({ kind: 'collection', operator: 'inArray', column: id('role'), values });
const allOf = (...predicates: Predicate[]): Predicate => ({ kind: 'group', operator: 'allOf', predicates });
const base: SelectSpec = { kind: 'select', from: id('users'), columns: '*' };
const compile = (spec: unknown) => compileQuery(spec, mysqlDialect);

describe('query builder compiler', () => {
  test('selects all columns by default specification', () => {
    expect(compile(base)).toEqual({ sql: 'SELECT * FROM `users`', parameters: [] });
  });

  test('quotes explicit qualified columns and escapes backticks', () => {
    expect(compile({ ...base, from: id('app', 'us`ers'), columns: [id('users', 'id'), id('na`me')] })).toEqual({
      sql: 'SELECT `users`.`id`, `na``me` FROM `app`.`us``ers`', parameters: [],
    });
  });

  test('compiles the complete POC example', () => {
    expect(compile({ ...base, columns: [id('id'), id('name')], where: allOf(eq('active', true), inArray(['admin', 'moderator'])), limit: 10 })).toEqual({
      sql: 'SELECT `id`, `name` FROM `users` WHERE (`active` = ? AND `role` IN (?, ?)) LIMIT ?',
      parameters: [true, 'admin', 'moderator', 10],
    });
  });

  test.each([false, 0, '', "' OR 1 = 1; --", 'a?@b:c'])('parameterizes eq value %p', (value) => {
    expect(compile({ ...base, where: eq('name', value) })).toEqual({
      sql: 'SELECT * FROM `users` WHERE `name` = ?', parameters: [value],
    });
  });

  test('empty inArray is false without parameters', () => {
    expect(compile({ ...base, where: inArray([]) })).toEqual({ sql: 'SELECT * FROM `users` WHERE 1 = 0', parameters: [] });
  });

  test('preserves nested group order and placeholder positions', () => {
    const spec = { ...base, where: allOf(eq('id', 1), allOf(inArray(['admin', 'moderator']), eq('active', false))), limit: 0 };
    const before = JSON.stringify(spec);
    expect(compileQuery(spec, { ...mysqlDialect, placeholder: (position) => `$${position}` })).toEqual({
      sql: 'SELECT * FROM `users` WHERE (`id` = $1 AND (`role` IN ($2, $3) AND `active` = $4)) LIMIT $5',
      parameters: [1, 'admin', 'moderator', false, 0],
    });
    expect(JSON.stringify(spec)).toBe(before);
  });

  test.each([0, 1, Number.MAX_SAFE_INTEGER])('parameterizes limit %p', (limit) => {
    expect(compile({ ...base, limit })).toEqual({ sql: 'SELECT * FROM `users` LIMIT ?', parameters: [limit] });
  });

  test.each([null, undefined, '', {}, [], { ...base, kind: 'delete' }, { ...base, orderBy: [] }].map((value) => [value]))('rejects invalid statements %p', (spec) => {
    expect(() => compile(spec)).toThrow('queryBuilder:');
  });

  test.each([id(), id(''), id(' '), id('a.b'), id('*'), id('a?b'), id('a\0b'), id('a\nb'), { kind: 'raw', parts: ['users'] }, { kind: 'identifier', parts: 'users' }, id('ok', '')])('rejects malformed identifiers %p', (from) => {
    expect(() => compile({ ...base, from })).toThrow('queryBuilder:');
  });

  test.each([[], 'id', ['id'], [id('*')], null, undefined].map((value) => [value]))('rejects invalid explicit selections %p', (columns) => {
    expect(() => compile({ ...base, columns })).toThrow('queryBuilder:');
  });

  test.each([null, undefined, NaN, Infinity, -Infinity, {}, [], new Date(), () => 1, { toSqlString: () => '1 OR 1=1' }].map((value) => [value]))('rejects non-scalar or missing values %p', (value) => {
    expect(() => compile({ ...base, where: eq('id', value) })).toThrow('values must be');
    expect(() => compile({ ...base, where: inArray([value]) })).toThrow('values must be');
  });

  test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])('rejects invalid limit %p', (limit) => {
    expect(() => compile({ ...base, limit })).toThrow('limit must be');
  });

  test.each([
    null, undefined, 'id = 1', { kind: 'raw', sql: '1=1' },
    { ...eq('id', 1), operator: '=' }, { ...inArray([]), operator: 'notInArray' },
    { ...allOf(eq('id', 1)), operator: 'anyOf' }, allOf(),
    { ...eq('id', 1), values: [] }, { ...inArray([]), values: {} },
    { ...inArray([]), values: [1, , 2] }, { ...allOf(), predicates: [eq('id', 1), , eq('id', 2)] },
  ])('rejects malformed predicates %p', (where) => {
    expect(() => compile({ ...base, where })).toThrow('queryBuilder:');
  });

  test('validates empty collection columns and cyclic predicates', () => {
    expect(() => compile({ ...base, where: { ...inArray([]), column: id('') } })).toThrow('identifier');
    const predicates: Predicate[] = [];
    const group: Predicate = { kind: 'group', operator: 'allOf', predicates };
    predicates.push(group);
    expect(() => compile({ ...base, where: group })).toThrow('nesting');
  });

  test('rejects prototypes, accessors, extra array keys and symbols', () => {
    expect(() => compile(Object.create(base))).toThrow('plain object');
    expect(() => compile({ ...base, get limit() { throw new Error('must not run'); } })).toThrow('unsupported statement field');
    expect(() => compile({ ...base, [Symbol('raw')]: 'bad' })).toThrow('unsupported statement field');
    expect(() => compile({ ...base, where: inArray(Object.assign([1], { extra: 2 })) })).toThrow('dense array');
  });
});

describe('mutation compiler', () => {
  const insert = { kind: 'insert', into: id('users'), rows: [{ name: 'Avery', active: true }] };
  const update = { kind: 'update', table: id('users'), values: { name: 'Blake', active: false }, where: eq('id', 7) };

  test('inserts one row with sorted columns and bound values', () => {
    expect(compile(insert)).toEqual({ sql: 'INSERT INTO `users` (`active`, `name`) VALUES (?, ?)', parameters: [true, 'Avery'] });
  });

  test('inserts multiple rows with consistent column order and numbered placeholders', () => {
    const spec = { ...insert, into: id('app', 'us`ers'), rows: [{ name: "' OR 1=1; --", active: true }, { active: false, name: '' }] };
    const before = JSON.stringify(spec);
    expect(compileQuery(spec, { ...mysqlDialect, placeholder: (position) => `$${position}` })).toEqual({
      sql: 'INSERT INTO `app`.`us``ers` (`active`, `name`) VALUES ($1, $2), ($3, $4)',
      parameters: [true, "' OR 1=1; --", false, ''],
    });
    expect(JSON.stringify(spec)).toBe(before);
  });

  test('updates sorted assignments before nested predicate parameters', () => {
    const spec = { ...update, where: allOf(eq('id', 7), inArray(['admin', 'moderator'])) };
    const before = JSON.stringify(spec);
    expect(compileQuery(spec, { ...mysqlDialect, placeholder: (position) => `$${position}` })).toEqual({
      sql: 'UPDATE `users` SET `active` = $1, `name` = $2 WHERE (`id` = $3 AND `role` IN ($4, $5))',
      parameters: [false, 'Blake', 7, 'admin', 'moderator'],
    });
    expect(JSON.stringify(spec)).toBe(before);
  });

  test('quotes mutation column names, including reserved names and backticks', () => {
    expect(compile({ ...update, table: id('app', 'us`ers'), values: { 'na`me': 'Avery', order: 0 } })).toEqual({
      sql: 'UPDATE `app`.`us``ers` SET `na``me` = ?, `order` = ? WHERE `id` = ?', parameters: ['Avery', 0, 7],
    });
  });

  test('supports allowAll explicitly and still honors predicates when present', () => {
    expect(compile({ kind: 'update', table: id('users'), values: { active: false }, allowAll: true })).toEqual({
      sql: 'UPDATE `users` SET `active` = ?', parameters: [false],
    });
    expect(compile({ ...update, allowAll: true })).toEqual(compile(update));
    expect(compile({ ...update, allowAll: false })).toEqual(compile(update));
  });

  test('empty collections cannot cause an unbounded update', () => {
    expect(compile({ ...update, where: inArray([]) })).toEqual({
      sql: 'UPDATE `users` SET `active` = ?, `name` = ? WHERE 1 = 0', parameters: [false, 'Blake'],
    });
  });

  test.each([undefined, null, false, true, 1, {}, [], [{}], [{ id: 1 }, {}], [{ id: 1 }, { name: 'Avery' }], [{ id: 1 }, , { id: 2 }]].map((value) => [value]))(
    'rejects malformed or inconsistent insert rows %p', (rows) => {
      expect(() => compile({ ...insert, rows })).toThrow('queryBuilder:');
    },
  );

  test.each([null, undefined, {}, [], new Date(), Object.create({ id: 1 })].map((value) => [value]))('rejects invalid update values %p', (values) => {
    expect(() => compile({ ...update, values })).toThrow('queryBuilder:');
  });

  test.each(['', ' ', 'users.id', '*', 'na?me', 'na\0me'])('rejects invalid mutation column %p', (column) => {
    expect(() => compile({ ...insert, rows: [{ [column]: 1 }] })).toThrow('identifier');
    expect(() => compile({ ...update, values: { [column]: 1 } })).toThrow('identifier');
  });

  test.each([null, undefined, NaN, Infinity, {}, [], new Date(), () => 1, { toSqlString: () => 'NOW()' }].map((value) => [value]))(
    'rejects non-scalar mutation value %p', (value) => {
      expect(() => compile({ ...insert, rows: [{ name: value }] })).toThrow('values must be');
      expect(() => compile({ ...update, values: { name: value } })).toThrow('values must be');
    },
  );

  test('rejects unsafe updates and unsupported clauses', () => {
    for (const allowAll of [undefined, false, 1, 'true', null]) {
      expect(() => compile({ kind: 'update', table: id('users'), values: { active: false }, allowAll })).toThrow('queryBuilder:');
    }
    expect(() => compile({ kind: 'update', table: id('users'), values: { active: false } })).toThrow('requires a predicate');
    for (const field of ['where', 'limit', 'columns', 'allowAll']) {
      expect(() => compile({ ...insert, [field]: true })).toThrow('unsupported insert field');
    }
    for (const field of ['limit', 'columns', 'orderBy']) {
      expect(() => compile({ ...update, [field]: true })).toThrow('unsupported update field');
    }
    expect(() => compile({ ...update, where: undefined, allowAll: true })).toThrow('predicate');
  });

  test('rejects accessors, symbols and non-enumerable values rather than silently omitting them', () => {
    const getter = { get name() { throw new Error('must not run'); } };
    const hidden = Object.defineProperty({ id: 1 }, 'name', { value: 'Avery' });
    for (const values of [getter, hidden, { id: 1, [Symbol('name')]: 'Avery' }]) {
      expect(() => compile({ ...insert, rows: [values] })).toThrow('queryBuilder:');
      expect(() => compile({ ...update, values })).toThrow('queryBuilder:');
    }
  });
});
