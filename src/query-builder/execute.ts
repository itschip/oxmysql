import { rawQuery } from '../database/rawQuery';
import { logError } from '../logger';
import { setCallback } from '../utils/setCallback';
import type { CFXCallback } from '../types';
import { compileQuery } from './compiler';
import { mysqlDialect } from './dialects/mysql';
import type { BuilderResultMode, CompiledQuery, SelectSpec } from './types';

export async function executeBuilderQuery(
  spec: SelectSpec,
  mode: BuilderResultMode,
  invokingResource: string,
  cb?: CFXCallback,
  isPromise?: boolean,
) {
  cb = setCallback([], cb);
  let compiled: CompiledQuery;

  try {
    if (mode !== 'query' && mode !== 'single') throw new Error('queryBuilder: result mode must be query or single.');
    compiled = compileQuery(spec, mysqlDialect);
  } catch (err) {
    return logError(invokingResource, cb, isPromise, err);
  }

  return rawQuery(mode === 'query' ? null : 'single', invokingResource, compiled.sql, compiled.parameters, cb, isPromise);
}