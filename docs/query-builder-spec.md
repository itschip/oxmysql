# Query Builder Specification

Status: SELECT proof of concept implemented; broader v1 features proposed

Implementation roadmap: [Query Builder Proof-of-Concept Plan](./query-builder-poc-plan.md)

## Summary

Add an optional query builder to oxmysql without changing the behavior or signatures of the existing raw SQL APIs. The first implementation targets MySQL, but its compiler is organized around a SQL dialect contract so PostgreSQL syntax can be added later.

The builder produces a serializable query specification. oxmysql compiles that specification into SQL and positional parameters, then sends the compiled result through the existing execution functions. SQL generation and database-driver behavior are separate concerns.

## Implemented proof of concept

The [POC plan](./query-builder-poc-plan.md) defines the currently implemented subset. Only `MySQL.table`, `select`, `where`, `limit`, `get`, `first`, and `MySQL.op.eq`, `inArray`, and `allOf` are available. The broader API and schema below remain a roadmap, not a claim of v1 completeness.

- The POC `SelectSpec.columns` is `Identifier[] | '*'`; omission of Lua `select` produces `'*'`. Explicit `select` requires a non-empty list of identifiers.
- Bound values are non-null strings, booleans, or finite numbers. Tables/objects and arrays are not scalar values: mysql2's text-query formatter expands them into SQL structures. JSON, binary, and null bindings need explicit future contracts.
- Identifiers are non-empty dot-separated segments. Segments reject wildcards, control characters, and `?`, which the existing text-query path would interpret as a placeholder even within quoted identifiers. Backticks are supported and doubled by the MySQL dialect. The default whole selection `'*'` is the only wildcard in the POC.
- Limits are parameterized non-negative safe integers. `first` caps the limit at one while preserving zero.
- Only documented spec fields, kinds, and operators are accepted. Predicate nesting is limited to 64 levels; unsupported statements and clauses are rejected rather than silently ignored.
- Builder state is private and immutable. Operators and terminal operations copy caller-owned tables; only fresh plain specifications cross the dedicated `queryBuilder` export.
- Validation failures use existing `logError` semantics. Awaited calls reject; normal callbacks retain the existing log-only error behavior unless `mysql_option 'return_callback_errors'` is set.
- No raw exports, compatibility aliases, or public TypeScript facade methods are changed. PostgreSQL and mutation support remain deferred.

## Goals

- Support a small, useful set of `SELECT`, `INSERT`, `UPDATE`, and `DELETE` queries.
- Parameterize values by default and quote identifiers through the active dialect.
- Provide a fluent Lua builder facade.
- Keep all existing `query`, `single`, `scalar`, `update`, `insert`, `prepare`, `rawExecute`, `transaction`, and compatibility exports working unchanged.
- Keep the query compiler independent from FiveM globals, database connections, and mysql2 so it can be unit tested without a server.
- Make PostgreSQL syntax and driver support additive follow-up work.

## Non-goals for the first version

- Replacing raw SQL or deprecating existing APIs.
- Supporting every SQL feature or every MySQL extension.
- Inferring a database schema or generating models.
- Accepting untrusted input as table names, column names, operators, or raw SQL.
- Shipping PostgreSQL connectivity in the same change as the first builder.
- Providing an ORM, migrations, relations, or change tracking.
- Providing a public TypeScript or JavaScript query-builder facade.

## Compatibility contract

The builder is additive. Existing calls continue to accept SQL strings and parameters exactly as they do today.

```lua
local rows = MySQL.query.await('SELECT * FROM users WHERE id = ?', { userId })
```

```ts
const rows = await oxmysql.query('SELECT * FROM users WHERE id = ?', [userId]);
```

The following behavior must not change:

- Callback, `.await`, `_async`, and deprecated `Sync` variants.
- Stored-query numeric references in `lib/MySQL.lua` and `lib/MySQL.ts`.
- `ghmattimysql` and `mysql-async` compatibility aliases.
- Named and positional parameter handling for raw SQL.
- Return shapes for query, single, scalar, update, insert, prepare, and transaction operations.
- Error logging, invoking-resource attribution, profiling, and transaction rollback behavior.

The initial implementation must not route existing SQL strings through the builder parser or compiler.

## Proposed public API

The public builder API is Lua-first. TypeScript remains the internal implementation language for query validation, compilation, and execution.

### Select

```lua
local op = MySQL.op

local rows = MySQL.table('users')
    :select({ 'id', 'name', 'created_at' })
  :where(op.eq('active', true))
  :where(op.inArray('role', { 'admin', 'moderator' }))
    :orderBy('created_at', 'desc')
    :limit(25)
    :get()
```

Predicate operators follow [Drizzle's operator model](https://orm.drizzle.team/docs/operators): functions such as `eq(column, value)` and `inArray(column, values)` create expressions that are passed to `where`. The Lua functions return plain predicate tables immediately; the functions themselves never cross the FiveM boundary.

MySQL compilation:

```sql
SELECT `id`, `name`, `created_at`
FROM `users`
WHERE `active` = ? AND `role` IN (?, ?)
ORDER BY `created_at` DESC
LIMIT ?
```

Parameters: `[true, 'admin', 'moderator', 25]`

### Single row and scalar

```lua
local user = MySQL.table('users'):where(MySQL.op.eq('id', userId)):first()
local count = MySQL.table('users'):count('*', 'total'):value('total')
```

`first()` uses the existing single-row response mode and adds `LIMIT 1` when no stricter limit exists. `value(column)` uses the existing scalar response mode; the selected column or alias must be explicit.

### Insert

```lua
local insertId = MySQL.table('users'):insert({
    name = 'Avery',
    active = true
})
```

MySQL compilation:

```sql
INSERT INTO `users` (`active`, `name`) VALUES (?, ?)
```

Object/map keys must be sorted before compilation so generated SQL and tests are deterministic. Multi-row inserts require every row to have the same key set.

### Update and delete

```lua
local changed = MySQL.table('users')
  :where(MySQL.op.eq('id', userId))
    :update({ active = false })

local removed = MySQL.table('sessions')
  :where(MySQL.op.lt('expires_at', os.time()))
    :delete()
```

`update()` and `delete()` must reject statements without a predicate by default. A deliberate `allowAll()` call is required for an unbounded mutation.

### Internal compilation

The TypeScript core exposes compilation internally for tests, logging, and execution:

```ts
const compiled = compileQuery(spec, mysqlDialect);

// {
//   sql: 'SELECT `id` FROM `users` WHERE `active` = ? LIMIT ?',
//   parameters: [true, 10]
// }
```

The Lua facade retains a plain-data specification and submits it to oxmysql only at a terminal operation such as `get()`, `first()`, `insert()`, `update()`, or `delete()`. Fluent Lua objects do not cross the FiveM export boundary. The compiler is not added to the public `lib/MySQL.ts` API in the first version.

## Version 1 feature set

### Statements

- `SELECT` with explicit columns or `*`.
- `INSERT` with one row or multiple rows.
- `UPDATE` with a values map.
- `DELETE`.

### Clauses

- `where(predicate)`; repeated calls combine predicates with `AND`.
- Comparison functions: `eq`, `ne`, `gt`, `gte`, `lt`, and `lte`.
- Pattern functions: `like` and `notLike`.
- Collection functions: `inArray`, `notInArray`, `between`, and `notBetween`.
- Null functions: `isNull` and `isNotNull`.
- Lua-safe composition functions: `allOf`, `anyOf`, and `not_`, corresponding to SQL `AND`, `OR`, and `NOT`.
- `innerJoin` and `leftJoin` with identifier-to-identifier comparisons.
- `groupBy`, `having`, `orderBy`, `limit`, and `offset`.
- Aggregate selections: `count`, `min`, `max`, `avg`, and `sum`.
- Column aliases.
- `distinct`.

### Deferred features

- Common table expressions and recursive queries.
- Unions.
- Window functions.
- Upserts and conflict handling.
- `RETURNING` and database-specific insert-return behavior.
- Schema-qualified mutation targets beyond the identifier model defined below.
- DDL statements.

## Query specification

The cross-resource representation must contain only plain objects/tables, arrays, strings, numbers, booleans, and null. It must not contain functions, class instances, symbols, or driver-specific objects.

```ts
type QuerySpec = SelectSpec | InsertSpec | UpdateSpec | DeleteSpec;

interface SelectSpec {
  kind: 'select';
  from: Identifier;
  columns: Selection[];
  distinct?: boolean;
  joins?: JoinSpec[];
  where?: Predicate;
  groupBy?: Identifier[];
  having?: Predicate;
  orderBy?: OrderSpec[];
  limit?: number;
  offset?: number;
}

interface InsertSpec {
  kind: 'insert';
  into: Identifier;
  rows: Record<string, unknown>[];
}

interface UpdateSpec {
  kind: 'update';
  table: Identifier;
  values: Record<string, unknown>;
  where?: Predicate;
  allowAll?: boolean;
}

interface DeleteSpec {
  kind: 'delete';
  from: Identifier;
  where?: Predicate;
  allowAll?: boolean;
}

interface CompiledQuery {
  sql: string;
  parameters: unknown[];
}

type Predicate =
  | {
      kind: 'comparison';
      operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'notLike';
      column: Identifier;
      value: unknown | Identifier;
    }
  | {
      kind: 'collection';
      operator: 'inArray' | 'notInArray';
      column: Identifier;
      values: unknown[];
    }
  | {
      kind: 'between';
      operator: 'between' | 'notBetween';
      column: Identifier;
      lower: unknown;
      upper: unknown;
    }
  | {
      kind: 'null';
      operator: 'isNull' | 'isNotNull';
      column: Identifier;
    }
  | {
      kind: 'group';
      operator: 'allOf' | 'anyOf';
      predicates: Predicate[];
    }
  | { kind: 'not'; predicate: Predicate };
```

The implementation should use discriminated unions rather than objects with many optional properties. Compiler functions must exhaustively switch on `kind`; the internal operator discriminants map to SQL and are never accepted as arbitrary SQL strings.

The Lua operator namespace constructs these tables locally:

```lua
local op = MySQL.op

local predicate = op.allOf(
    op.eq('active', true),
    op.anyOf(
        op.inArray('role', { 'admin', 'moderator' }),
        op.gte('reputation', 100)
    )
)
```

For identifier-to-identifier comparisons, `op.column('teams.id')` creates an identifier operand. Ordinary strings remain parameterized values.

## Identifiers, values, and raw SQL

Identifiers and values are different data types:

- Identifiers are table names, column names, aliases, and qualified paths supplied by application code.
- Values are always added to the parameter array and represented by a dialect placeholder.
- Operator functions produce closed internal discriminants; callers never provide SQL operator strings.
- Sort directions come from a closed allowlist.
- Identifier quoting is not a substitute for authorization. Applications must not pass arbitrary user input as an identifier.

An identifier is represented as path segments, not parsed with unrestricted string splitting:

```ts
type Identifier = {
  kind: 'identifier';
  parts: string[];
};
```

Convenience methods may accept `users.id`, but must validate and convert it into `['users', 'id']` before compilation. `*` is allowed only in selection contexts and is never quoted.

Raw SQL is an explicit escape hatch:

```ts
interface RawExpression {
  kind: 'raw';
  sql: string;
  parameters: unknown[];
}
```

Raw expressions must be visibly named `raw`, must never interpolate values, and must preserve placeholder numbering through the dialect compiler. The first release may defer public raw expressions if this cannot be implemented safely.

## Null and collection semantics

- `isNull(column)` compiles as `IS NULL`.
- `isNotNull(column)` compiles as `IS NOT NULL`.
- Missing comparison values are rejected; Lua callers use the explicit null functions instead of passing `nil` to `eq` or `ne`.
- `inArray(column, {})` compiles as an always-false predicate.
- `notInArray(column, {})` compiles as an always-true predicate.
- `between(column, lower, upper)` and `notBetween(column, lower, upper)` require both bounds.
- Undefined values in internal TypeScript representations are rejected.

These rules are compiler behavior and must be reflected consistently by the Lua facade.

## Architecture

### Lua builder facade

The Lua facade owns ergonomics, immutable state transitions, and predicate operator functions. It creates a serializable `QuerySpec`; it does not generate SQL, access configuration, or call a database driver directly.

Suggested location:

```text
src/query-builder/
  index.ts
  types.ts
  compiler.ts
  validation.ts
  predicates.ts
  dialect.ts
  dialects/
    mysql.ts
```

Consumer-language bindings remain in:

```text
lib/MySQL.lua
```

The existing `lib/MySQL.ts` raw-query wrapper remains supported but does not gain builder methods in the first version.

### Compiler

The compiler is a pure function:

```ts
type CompileQuery = (spec: QuerySpec, dialect: QueryDialect) => CompiledQuery;
```

It validates the specification, walks predicates in a deterministic order, emits SQL, and appends parameters. It has no knowledge of callbacks, result parsing, connection pools, resources, or logging.

### Query dialect

The dialect owns SQL rendering differences only:

```ts
interface QueryDialect {
  readonly name: 'mysql' | 'postgresql';
  placeholder(position: number): string;
  quoteIdentifierPart(part: string): string;
  compileLimitOffset(limit?: number, offset?: number): SqlFragment;
  compileBoolean(value: boolean): unknown;
  readonly capabilities: {
    returning: boolean;
  };
}
```

The MySQL dialect uses backticks and `?`. A future PostgreSQL dialect uses double quotes and numbered placeholders such as `$1`.

Do not put connection creation, result parsing, type casting, or profiler SQL on `QueryDialect`.

### Database driver adapter

PostgreSQL support requires more than a query dialect. The current code directly depends on mysql2 types and behavior in configuration, pool creation, connection handling, raw execution, result parsing, type casting, validation, and profiling.

A later PostgreSQL milestone should introduce a separate driver contract along these lines:

```ts
interface DatabaseDriver {
  readonly name: 'mysql' | 'postgresql';
  createPool(connectionString: string): Promise<DatabasePool>;
  parseConnectionOptions(connectionString: string): unknown;
  normalizeResult(result: unknown): NormalizedResult;
  prepareRawQuery(sql: string, parameters: unknown): CompiledQuery;
  transactionIsolationStatement(level: number): string;
  serverVersion(pool: DatabasePool): Promise<string>;
  profileQuery?(connection: DatabaseConnection): Promise<number | null>;
}
```

The exact driver interface should be extracted from real call sites during the PostgreSQL work. Do not refactor all current mysql2 code before the builder needs it.

### Execution bridge

Add a small execution bridge in the oxmysql resource:

1. Receive a plain `QuerySpec`, operation/result mode, callback, invoking resource, and promise flag.
2. Compile with the configured query dialect.
3. Forward `compiled.sql` and `compiled.parameters` to the existing `rawQuery` path.
4. Preserve existing result parsing and error handling.

The bridge should be a new export used by the Lua facade. Existing exports remain unchanged. `prepare` and batched `rawExecute` support are deferred until their semantics are explicitly designed.

## Suggested implementation phases

### Phase 1: Pure MySQL compiler

- Add query-spec types, validation, predicate compilation, and `mysqlDialect`.
- Unit test exact SQL and parameter output.
- Do not touch the connection pool or existing raw SQL path.

### Phase 2: Lua facade and execution bridge

- Add a fluent Lua facade that creates plain query specifications.
- Add the dedicated builder execution export.
- Execute compiled queries through `rawQuery` and existing response modes.
- Add compatibility tests proving existing exports still behave identically.
- Keep terminal execution in oxmysql; do not duplicate SQL compilation in Lua.
- Use the `query-builder-test` resource for end-to-end Lua examples.

### Phase 3: PostgreSQL preparation

- Add compiler golden tests that run the same query specifications against MySQL and PostgreSQL dialects.
- Inventory mysql2-specific behavior and extract a database-driver adapter from actual execution call sites.
- Define how legacy `?`, named placeholders, insert IDs, affected rows, prepared batches, type casting, and profiling map to PostgreSQL.

### Phase 4: PostgreSQL driver

- Add the PostgreSQL client dependency and adapter.
- Select the adapter from the connection-string scheme or an explicit convar.
- Run the shared integration suite against both databases.

## Testing requirements

### Compiler unit tests

- Exact SQL and parameter ordering for every statement and clause.
- Identifier escaping, including embedded quote characters.
- Placeholder numbering across nested predicates and raw fragments.
- Null functions, empty `inArray`, nested boolean groups, and invalid predicate behavior.
- Deterministic insert/update key ordering.
- Rejection of empty inserts, empty updates, negative limits, and unbounded mutations.
- Immutability when a base builder is reused.

### Execution tests

- Each terminal builder operation selects the correct existing result mode.
- Compiler errors occur before acquiring a database connection.
- Invoking resource, callback errors, and promise rejection behavior are preserved.
- Existing raw SQL unit tests pass without modification.

### Contract tests

- The Lua facade generates the expected plain-data query specifications.
- Every Lua operator function returns only serializable predicate data.
- A query specification survives FiveM serialization without prototypes or functions.
- Compatibility aliases continue to receive strings and parameters only.

### Future dialect tests

Use shared fixtures:

```ts
for (const dialect of [mysqlDialect, postgresqlDialect]) {
  test(`${dialect.name}: nested predicate`, () => {
    expect(compileQuery(spec, dialect)).toEqual(expected[dialect.name]);
  });
}
```

Integration tests must run against real MySQL and PostgreSQL instances before PostgreSQL support is considered complete.

## Security requirements

- Parameterize every value, including limits and offsets when the driver supports it.
- Map operator-function discriminants, join kinds, sort directions, and aggregate names through allowlists.
- Quote every identifier segment with the active dialect.
- Reject malformed query specifications before opening a connection.
- Require `allowAll()` for update or delete without a predicate.
- Never silently treat a string value as raw SQL.
- Include generated SQL and sanitized parameters in existing diagnostics without logging credentials.

## Completion criteria for MySQL v1

- The documented statement and clause subset is implemented for MySQL.
- The Lua facade supports callback and await-style terminal operations consistently with existing Lua APIs.
- Existing public APIs and compatibility aliases pass their current tests unchanged.
- Compiler tests require no FiveM runtime or live database.
- End-to-end examples run from the `query-builder-test` resource.
- Unsupported operations fail with actionable errors rather than emitting questionable SQL.
- Public documentation clearly labels the builder as additive and the PostgreSQL driver as future work.

## Open decisions

Resolve these before the corresponding implementation phase:

1. Whether a compile-only public export is worth supporting across the FiveM boundary.
2. Whether future offset support needs validated integer literals for driver compatibility. POC limits use parameters.