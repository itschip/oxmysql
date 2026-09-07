# Query Builder Proof-of-Concept Plan

Status: Implemented; live FiveM/MySQL validation pending environment configuration

This plan narrows [the query builder specification](./query-builder-spec.md) to the smallest working Lua-first vertical slice. The branch should prove the complete path from a fluent Lua call to parameterized MySQL execution while establishing code boundaries that PostgreSQL and additional operations can extend later.

## Proof-of-concept outcome

The following calls should work from a FiveM Lua resource:

```lua
local op = MySQL.op

local users = MySQL.table('users')
    :select({ 'id', 'name' })
    :where(op.eq('active', true))
    :where(op.inArray('role', { 'admin', 'moderator' }))
    :limit(10)
    :get()

local user = MySQL.table('users')
    :where(op.eq('id', userId))
    :first()
```

The first query compiles to:

```sql
SELECT `id`, `name` FROM `users` WHERE (`active` = ? AND `role` IN (?, ?)) LIMIT ?
```

Parameters: `[true, 'admin', 'moderator', 10]`

## Included scope

- MySQL query dialect.
- `SELECT` statements only.
- `MySQL.table(name)` Lua entry point.
- `select(columns)`, `where(predicate)`, `limit(number)`, `get(callback?)`, and `first(callback?)`.
- `MySQL.op.eq`, `MySQL.op.inArray`, and `MySQL.op.allOf`.
- Repeated `where` calls combined with `AND`.
- Awaited terminal calls when no callback is supplied.
- Existing callback behavior when a callback is supplied.
- Pure compiler tests and execution-bridge tests.
- A Lua smoke-test resource.

## Explicitly deferred

- Insert, update, and delete.
- `ne`, range comparisons, null predicates, `notInArray`, `anyOf`, and `not_`.
- Joins, grouping, having, ordering, offset, aliases, aggregates, and distinct.
- Raw SQL expressions and subqueries.
- Prepared/batched builder execution.
- A TypeScript or JavaScript public builder.
- PostgreSQL dialect and database driver adapters.
- Schema metadata and compile-time column validation.

Deferred operations should fit the established predicate and statement unions without changing the POC contracts.

## Code structure

```text
src/query-builder/
  types.ts
  dialect.ts
  dialects/
    mysql.ts
  compiler.ts
  execute.ts
  index.ts
tests/unit/query-builder/
  compiler.test.ts
  execute.test.ts
lib/
  MySQL.lua
docs/
  query-builder-spec.md
  query-builder-poc-plan.md

query-builder-test/
  fxmanifest.lua
  server.lua

.vscode/
  tasks.json
```

Responsibilities:

- `types.ts`: Serializable query, identifier, predicate, compiled-query, and result-mode types.
- `dialect.ts`: Minimal syntax contract: dialect name, identifier quoting, and positional placeholder rendering.
- `dialects/mysql.ts`: Backtick escaping and `?` placeholders only.
- `compiler.ts`: Pure validation and deterministic SQL/parameter generation.
- `execute.ts`: Compile first, then route to the existing `rawQuery` function.
- `index.ts`: Public exports for the internal compiler and execution bridge.
- `lib/MySQL.lua`: Self-contained fluent facade and operator constructors used by consumer resources.

Do not introduce `src/drivers` in the POC. No new driver boundary is needed until PostgreSQL connectivity is implemented.

## Internal contracts

### Serializable query specification

```ts
interface SelectSpec {
  kind: 'select';
  from: Identifier;
  columns: Identifier[] | '*';
  where?: Predicate;
  limit?: number;
}

interface Identifier {
  kind: 'identifier';
  parts: string[];
}

type Predicate =
  | {
      kind: 'comparison';
      operator: 'eq';
      column: Identifier;
      value: unknown;
    }
  | {
      kind: 'collection';
      operator: 'inArray';
      column: Identifier;
      values: unknown[];
    }
  | {
      kind: 'group';
      operator: 'allOf';
      predicates: Predicate[];
    };

interface CompiledQuery {
  sql: string;
  parameters: unknown[];
}
```

The actual types may be readonly. They must remain plain-data compatible after crossing the FiveM export boundary.

### Minimal dialect

```ts
interface QueryDialect {
  readonly name: 'mysql' | 'postgresql';
  placeholder(position: number): string;
  quoteIdentifierPart(part: string): string;
}
```

The compiler owns statement assembly and operator mapping. The dialect owns syntax differences only. Keep the placeholder position argument even though MySQL returns `?`; PostgreSQL will need it later.

### Execution bridge

```ts
type BuilderResultMode = 'query' | 'single';

executeBuilderQuery(
  spec: SelectSpec,
  mode: BuilderResultMode,
  invokingResource: string,
  cb?: CFXCallback,
  isPromise?: boolean,
): Promise<unknown> | void;
```

The bridge must:

1. Validate and compile before requesting a connection.
2. Map `query` to `rawQuery(null, ...)` and `single` to `rawQuery('single', ...)`.
3. Forward the compiled SQL and parameters unchanged.
4. Use existing error reporting semantics for compiler failures.
5. Accept only the two POC result modes; never trust arbitrary response modes from Lua.

Register one dedicated FiveM export, `queryBuilder`, outside the generic export loop in `src/index.ts`. This prevents accidental `_async`, `Sync`, `ghmattimysql`, or `mysql-async` aliases and avoids forcing the builder signature into the existing SQL-string wrapper.

## Lua facade contract

`lib/MySQL.lua` remains self-contained because consumer manifests load that file directly. Do not duplicate SQL compilation in Lua.

- `MySQL.op.eq(column, value)` returns a plain comparison predicate.
- `MySQL.op.inArray(column, values)` returns a plain collection predicate.
- `MySQL.op.allOf(...)` returns a plain group predicate.
- `MySQL.table(name)` returns a new immutable builder state.
- Each chain method returns a new state so a base builder can be reused safely.
- Repeated `where` calls normalize to one `allOf` group.
- `select` defaults to `*` when omitted.
- `first` enforces a maximum limit of one and requests the `single` result mode.
- `get(callback)` and `first(callback)` use callback execution.
- `get()` and `first()` create a promise and await the same export, matching existing Lua error behavior.

The Lua facade validates obvious API misuse for immediate feedback. The TypeScript compiler repeats trust-boundary validation because query specifications can call the export directly.

## Validation rules for the POC

- Identifier input must be a non-empty string of dot-separated non-empty segments.
- Every identifier segment is quoted independently.
- Identifier segments reject wildcards, control characters, and `?`; mysql2's text-query formatter interprets `?` as a placeholder even inside quoted identifiers. The default `columns: '*'` selection is supported.
- A backtick inside a MySQL identifier segment is escaped by doubling it.
- Values are always emitted as parameters.
- POC values are non-null strings, booleans, or finite numbers. Object/array values are rejected because mysql2 expands them into SQL structures rather than binding them as scalars.
- `eq` requires a value; `nil` is rejected until `isNull` exists.
- `inArray` requires a dense array-like table.
- Empty `inArray` compiles to an always-false predicate such as `1 = 0` and adds no parameters.
- `allOf` requires at least one predicate.
- `select` requires at least one column when explicitly called.
- `limit` must be a non-negative safe integer and is parameterized.
- Unknown statement kinds, predicate kinds, and operator discriminants are rejected.
- Unknown specification fields are rejected and predicate nesting is limited to 64 levels.

## Implementation sequence

### 0. Validation tasks

Create `.vscode/tasks.json` with workspace-scoped tasks for:

- Focused query-builder unit tests.
- The complete unit suite.
- The project build/typecheck.

All implementation commands should run through these tasks. Do not encode database credentials in task definitions.

Exit criterion: each non-database validation command can be launched reproducibly from VS Code.

### 1. Pure compiler

Create `types.ts`, `dialect.ts`, `dialects/mysql.ts`, `compiler.ts`, and `index.ts`.

Tests in `compiler.test.ts` should cover:

- `SELECT * FROM table`.
- Explicit and qualified columns.
- MySQL identifier escaping.
- `eq` parameterization.
- Expanded `inArray` parameters.
- Empty `inArray` behavior.
- Repeated/nested `allOf` ordering.
- Parameterized limit.
- Rejection of malformed identifiers, missing values, invalid limits, and unknown discriminants.

Exit criterion: compiler tests pass without FiveM globals, mysql2, or a database connection.

### 2. Execution bridge

Create `execute.ts` and register `queryBuilder` in `src/index.ts` separately from the existing `MySQL` export loop.

Tests in `execute.test.ts` should prove:

- `query` uses the existing general-query response mode.
- `single` uses the existing single-row response mode.
- Generated SQL and parameters reach the fake connection unchanged.
- Invalid specs fail before a connection is acquired.
- Callback and promise-style errors match current query behavior.
- Existing raw-query tests remain unchanged and pass.

Exit criterion: a plain query specification executes through the current database path with no compatibility aliases or existing signatures changed.

### 3. Lua facade

Add the operator constructors and immutable builder to `lib/MySQL.lua`. Keep existing `MySQL` methods and aliases untouched.

The facade should call only the dedicated `queryBuilder` export at terminal operations. Add no builder methods to `lib/MySQL.ts`.

Exit criterion: the example Lua calls produce serializable specs and reach the execution bridge in callback and await forms.

### 4. FiveM smoke resource

Populate the existing `query-builder-test` resource with:

- An `fxmanifest.lua` that depends on oxmysql and loads `@oxmysql/lib/MySQL.lua`.
- A `server.lua` command or startup thread that runs the two POC examples against a known fixture table.
- Assertions for a result list, a single result, and an empty `inArray` result.

Keep fixture creation as raw SQL. The POC builder does not need DDL support.

Exit criterion: the builder works across the real Lua-to-JavaScript export boundary on the FiveM server.

### 5. Branch completion checks

- Run focused compiler and execution tests.
- Run the full existing unit suite.
- Run the project build/typecheck.
- Run the FiveM smoke resource against MySQL.
- Verify existing Lua raw SQL calls still work.
- Review the compatibility and security checklists in the main specification.

## Branch acceptance criteria

- Both POC examples execute successfully from Lua.
- SQL values are parameterized and identifiers are dialect-quoted.
- The compiler is pure and covered by exact SQL/parameter tests.
- The Lua facade sends only plain serializable query specifications.
- Existing raw APIs and compatibility aliases are unchanged.
- The MySQL dialect can be paired with a future PostgreSQL dialect without changing the query specification.
- Unsupported operations fail clearly rather than leaking into generic raw SQL strings.

## First follow-up after the POC

Add predicate functions in one coherent batch: `ne`, `gt`, `gte`, `lt`, `lte`, `isNull`, `isNotNull`, `notInArray`, `anyOf`, and `not_`. This extends the predicate union and compiler without changing the execution bridge or Lua builder lifecycle.

## Running the validation tasks

Use **Tasks: Run Task** in the oxmysql workspace folder:

| Task | Purpose |
| --- | --- |
| `test: compiler standalone` | Compiler tests with no FiveM or mysql2 mock preload |
| `test: query builder` | Compiler, execution, and dedicated export regression tests |
| `check: execution` | Builder tests plus unchanged raw-query tests |
| `test: unit` | Complete unit suite |
| `test: Lua facade` | Exact Lua specifications, immutability, callback/await behavior, and raw API regressions |
| `check: smoke syntax` | Parse the sibling FiveM smoke resource |
| `build: project` | Server bundle, web build, and public library build |
| `check: types` | Full root TypeScript check, including tests |
| `check: compiler types` | Standalone strict compiler typecheck |

Tasks use the cached `npx bun@1.3.14` runner because the installed Bun 1.3.5 failed to resolve existing wildcard TypeScript paths on Windows. The Lua contract task uses Fengari through `npx`; it does not replace real FiveM serialization or MySQL testing. The first invocation needs access to the npm registry. No task contains database credentials.

## Live smoke resource

Configure `mysql_connection_string` on the FiveM server outside task definitions, then build oxmysql and start the server. The database account needs permission to create, insert into, select from, and drop a uniquely named `oxmysql_qb_poc_*` fixture table.

Run these in the **server console**, not a shell:

```text
ensure oxmysql
ensure query-builder-test
query_builder_smoke
```

If oxmysql was already running an older build, restart it before starting the smoke resource. Alternatively set `query_builder_smoke_auto` to `1` before starting the test resource. The smoke command is server-console-only, creates no permanent fixture on success, and prints `QUERY_BUILDER_SMOKE_PASS` only after all assertions and cleanup succeed. It covers both examples, empty `inArray`, zero-limit `first`, callbacks, immutable base reuse, and existing raw/stored-query APIs. A cleanup failure is reported as a test failure; an interrupted server may require manual removal of its fixture table.

## Verification record

- Focused compiler/execution tests and dedicated export registration passed.
- Standalone compiler: 69 tests passed without FiveM globals or a mysql2 mock; strict standalone compiler typecheck passed.
- Full unit suite: 222 passed, zero failures.
- Lua facade contract: eight tests passed; smoke resource syntax passed.
- Full project build passed.
- Full root typecheck was run and reported 20 existing diagnostics. An in-memory comparison with the pre-change TypeScript entry point and file set confirmed the same 20 diagnostics and zero new errors. Existing failures include dependency declaration conflicts, raw transaction/connection tests, `startTransaction`, `typeCast`, and the public TypeScript library.
- Live FiveM/MySQL execution remains unverified: FXServer is installed but was not running, and the local server configuration had no `mysql_connection_string`. No credentials or server configuration were changed.