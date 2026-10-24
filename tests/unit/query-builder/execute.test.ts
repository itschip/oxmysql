import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { resetNatives, setConvar } from '../../setup';
import { resetDb, setConnectionFactory, createFakeConnection, issuedConnections, type FakeConnection } from '../../helpers/db';
import * as config from '../../../src/config';
import type { BuilderResultMode, QuerySpec, SelectSpec } from '../../../src/query-builder/types';

const { createConnectionPool } = await import('../../../src/database/pool');
await createConnectionPool();
const { executeBuilderQuery } = await import('../../../src/query-builder/execute');
const spec: SelectSpec = {
  kind: 'select', from: { kind: 'identifier', parts: ['users'] }, columns: '*',
  where: { kind: 'comparison', operator: 'eq', column: { kind: 'identifier', parts: ['active'] }, value: true },
  limit: 10,
};
let conn: FakeConnection;
let errors: ReturnType<typeof spyOn>;
let events: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetNatives();
  setConvar('mysql_debug', 'false');
  config.setDebug();
  resetDb();
  conn = createFakeConnection();
  setConnectionFactory(() => conn);
  errors = spyOn(console, 'error').mockImplementation(() => {});
  events = spyOn(globalThis, 'TriggerEvent');
});

afterEach(() => {
  errors.mockRestore();
  events.mockRestore();
});

describe('query builder execution', () => {
  test('forwards compiled SQL and ordered parameters through the existing query path', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    conn.queue.push(rows);
    expect(await executeBuilderQuery(spec, 'query', 'builder-resource')).toEqual(rows);
    expect(conn.calls[0]).toEqual({ op: 'query', arg: { sql: 'SELECT * FROM `users` WHERE `active` = ? LIMIT ?', values: [true, 10] } });
    expect(conn.ops()).toEqual(['query', 'release']);
  });

  test('single selects the existing first-row response mode', async () => {
    conn.queue.push([{ id: 1 }, { id: 2 }]);
    expect(await executeBuilderQuery({ ...spec, limit: 1 }, 'single', 'builder-resource')).toEqual({ id: 1 });
    expect(conn.calls[0].arg.values).toEqual([true, 1]);
  });

  test('single returns null for no rows', async () => {
    conn.queue.push([]);
    expect(await executeBuilderQuery(spec, 'single', 'builder-resource')).toBeNull();
  });

  test.each(['query', 'single'] as const)('%s supports callbacks', async (mode) => {
    const rows = [{ id: 1 }, { id: 2 }];
    conn.queue.push(rows);
    const received: unknown[] = [];
    expect(await executeBuilderQuery(spec, mode, 'builder-resource', (result) => received.push(result))).toBeUndefined();
    expect(received).toEqual([mode === 'query' ? rows : rows[0]]);
  });

  test('invalid specs return promise-style errors before acquiring a connection', async () => {
    const received: unknown[][] = [];
    await executeBuilderQuery({ ...spec, limit: -1 }, 'query', 'builder-resource', (...args) => received.push(args), true);
    expect(issuedConnections()).toHaveLength(0);
    expect(received[0][0]).toBeNull();
    expect(received[0][1]).toContain('builder-resource was unable to execute a query!');
    expect(received[0][1]).toContain('limit must be');
    expect(errors).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith('oxmysql:error', expect.objectContaining({ resource: 'builder-resource' }));
  });

  test.each(['scalar', 'insert', 'update', 'delete', '', null, undefined])('rejects unsupported or mismatched mode %p before connection acquisition', async (mode) => {
    const received: unknown[][] = [];
    await executeBuilderQuery(spec, mode as BuilderResultMode, 'builder-resource', (...args) => received.push(args), true);
    expect(issuedConnections()).toHaveLength(0);
    expect(received[0][1]).toContain('result mode must match the statement');
  });

  test('normal callback validation failures log without invoking the callback, like rawQuery', async () => {
    const received: unknown[] = [];
    await executeBuilderQuery({ ...spec, limit: -1 }, 'query', 'builder-resource', (result) => received.push(result));
    expect(received).toEqual([]);
    expect(errors).toHaveBeenCalled();
    expect(issuedConnections()).toHaveLength(0);
  });

  test('promise-style database errors preserve attribution, SQL and parameters', async () => {
    conn.failOn.query = new Error('query failed');
    const received: unknown[][] = [];
    await executeBuilderQuery(spec, 'query', 'builder-resource', (...args) => received.push(args), true);
    expect(received[0][0]).toBeNull();
    expect(received[0][1]).toContain('builder-resource was unable to execute a query!');
    expect(received[0][1]).toContain('query failed');
    expect(events).toHaveBeenCalledWith('oxmysql:error', expect.objectContaining({
      resource: 'builder-resource', query: 'SELECT * FROM `users` WHERE `active` = ? LIMIT ?', parameters: [true, 10],
    }));
    expect(conn.ops()).toEqual(['query', 'release']);
  });

  test('normal callback database failures retain existing log-only behavior', async () => {
    conn.failOn.query = new Error('query failed');
    const received: unknown[] = [];
    await executeBuilderQuery(spec, 'query', 'builder-resource', (result) => received.push(result));
    expect(received).toEqual([]);
    expect(errors).toHaveBeenCalled();
    expect(conn.ops()).toEqual(['query', 'release']);
  });

  test('retains invoking-resource profiler selection', async () => {
    setConvar('mysql_debug', '["builder-resource"]');
    config.setDebug();
    await executeBuilderQuery(spec, 'query', 'builder-resource');
    expect(conn.calls.some((call) => call.op === 'query' && String(call.arg.sql).includes('PROFILING'))).toBe(true);
  });
});

describe('mutation execution', () => {
  const insert: QuerySpec = { kind: 'insert', into: spec.from, rows: [{ name: 'Avery', active: true }] };
  const update: QuerySpec = { kind: 'update', table: spec.from, values: { active: false }, where: spec.where };

  test.each([
    { spec: insert, mode: 'insert' as const, result: 42, sql: 'INSERT INTO `users` (`active`, `name`) VALUES (?, ?)', values: [true, 'Avery'] },
    { spec: update, mode: 'update' as const, result: 3, sql: 'UPDATE `users` SET `active` = ? WHERE `active` = ?', values: [false, true] },
  ])('$mode returns the existing mutation result for direct and callback calls', async ({ spec, mode, result, sql, values }) => {
    for (const useCallback of [false, true]) {
      conn.queue.push({ insertId: 42, affectedRows: 3 });
      const received: unknown[] = [];
      const returned = await executeBuilderQuery(spec, mode, 'builder-resource', useCallback ? (value) => received.push(value) : undefined);
      expect(useCallback ? received : returned).toEqual(useCallback ? [result] : result);
      expect(conn.calls.filter((call) => call.op === 'query').at(-1)?.arg).toEqual({ sql, values });
    }
    expect(conn.ops()).toEqual(['query', 'release', 'query', 'release']);
  });

  test('preserves zero insert IDs and zero affected rows', async () => {
    conn.queue.push({ insertId: 0, affectedRows: 0 }, { insertId: 0, affectedRows: 0 });
    expect(await executeBuilderQuery(insert, 'insert', 'builder-resource')).toBe(0);
    expect(await executeBuilderQuery(update, 'update', 'builder-resource')).toBe(0);
  });

  test('rejects unsafe mutations and mismatched result modes before connecting', async () => {
    for (const [input, mode] of [
      [{ kind: 'update', table: spec.from, values: { active: false } }, 'update'],
      [{ ...insert, rows: [] }, 'insert'],
      [insert, 'query'], [insert, 'single'], [insert, 'update'], [update, 'insert'], [update, 'query'],
    ] as const) {
      const received: unknown[][] = [];
      await executeBuilderQuery(input as QuerySpec, mode, 'builder-resource', (...args) => received.push(args), true);
      expect(received[0][0]).toBeNull();
      expect(received[0][1]).toContain('queryBuilder:');
    }
    expect(issuedConnections()).toHaveLength(0);
  });

  test.each([{ spec: insert, mode: 'insert' as const }, { spec: update, mode: 'update' as const }])(
    '$mode preserves promise and callback database error handling', async ({ spec, mode }) => {
      conn.failOn.query = new Error('mutation failed');
      const received: unknown[][] = [];
      await executeBuilderQuery(spec, mode, 'builder-resource', (...args) => received.push(args), true);
      expect(received[0][0]).toBeNull();
      expect(received[0][1]).toContain('mutation failed');
      expect(events).toHaveBeenCalledWith('oxmysql:error', expect.objectContaining({ resource: 'builder-resource' }));
      const callbacks: unknown[] = [];
      await executeBuilderQuery(spec, mode, 'builder-resource', (result) => callbacks.push(result));
      expect(callbacks).toEqual([]);
      expect(errors).toHaveBeenCalled();
      expect(conn.ops()).toEqual(['query', 'release', 'query', 'release']);
    },
  );
});
