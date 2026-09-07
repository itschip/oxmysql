import { expect, mock, test } from 'bun:test';
import { resetNatives, setConvar } from '../../setup';
import { resetDb, createFakeConnection, setConnectionFactory } from '../../helpers/db';
import * as config from '../../../src/config';

mock.module('../../../src/update', () => ({}));

test('registers only the dedicated builder export while retaining raw exports and compatibility aliases', async () => {
  resetNatives();
  setConvar('mysql_debug', 'false');
  config.setDebug();
  resetDb();
  const conn = createFakeConnection();
  setConnectionFactory(() => conn);
  const { createConnectionPool } = await import('../../../src/database/pool');
  await createConnectionPool();
  const registered = new Map<string, Function>();
  const provided = new Map<string, Function>();
  const natives = globalThis as any;
  const previousExports = natives.exports;
  const previousOn = natives.on;
  natives.exports = (name: string, callback: Function) => registered.set(name, callback);
  natives.on = (name: string, callback: Function) => provided.set(name, callback);

  try {
    const { default: rawApi } = await import('../../../src/index');
    expect(registered.has('queryBuilder')).toBe(true);
    expect(registered.has('queryBuilder_async')).toBe(false);
    expect(registered.has('queryBuilderSync')).toBe(false);
    expect(Object.hasOwn(rawApi, 'queryBuilder')).toBe(false);
    expect([...provided.keys()].some((name) => name.includes('queryBuilder'))).toBe(false);

    for (const method of ['query', 'single', 'scalar', 'update', 'insert', 'prepare', 'rawExecute', 'transaction', 'execute', 'fetch']) {
      expect(registered.has(method)).toBe(true);
      expect(registered.has(`${method}_async`)).toBe(true);
      expect(registered.has(`${method}Sync`)).toBe(true);
    }
    expect(provided.has('__cfx_export_ghmattimysql_execute')).toBe(true);
    expect(provided.has('__cfx_export_mysql-async_mysql_fetch_all')).toBe(true);

    conn.queue.push([{ id: 1 }]);
    const rows = await new Promise((resolve, reject) => {
      registered.get('queryBuilder')!(
        { kind: 'select', from: { kind: 'identifier', parts: ['users'] }, columns: '*' },
        'query', (result: unknown, error: string) => error ? reject(new Error(error)) : resolve(result),
        'lua-resource', true,
      );
    });
    expect(rows).toEqual([{ id: 1 }]);
    expect(conn.calls[0].arg).toEqual({ sql: 'SELECT * FROM `users`', values: [] });

    conn.queue.push([{ raw: 7 }]);
    expect(await registered.get('query_async')!('SELECT ? AS raw', [7], 'raw-resource')).toEqual([{ raw: 7 }]);
    expect(conn.calls[2].arg).toEqual({ sql: 'SELECT ? AS raw', values: [7] });
  } finally {
    natives.exports = previousExports;
    natives.on = previousOn;
  }
});