---
name: oxmysql-query-builder
description: Write, migrate, or debug FiveM server Lua queries using oxmysql's Builder import and fluent SELECT query builder. Use for Builder.table, Builder.op, builder imports, predicates, and callback or awaited execution. Covers the implemented SELECT subset; use MySQL raw SQL APIs for unsupported operations.
---

# oxmysql query builder

Use the standalone `Builder` Lua API to construct parameterized SELECT queries. The current implementation supports MySQL and is a proof of concept. The broader query builder specification includes proposed APIs that are not implemented yet.

## Resource setup

Add the builder import before the consuming server scripts in the resource's `fxmanifest.lua`. Declare the oxmysql dependency. Load `MySQL.lua` too when the resource uses raw SQL functions:

```lua
dependency 'oxmysql'

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    '@oxmysql/lib/Builder.lua',
    'server.lua',
}
```

The two imports are independent and can appear in either order. Builder-only resources can omit `MySQL.lua`. Keep raw SQL calls under `MySQL`; use `Builder.table` and `Builder.op` for the fluent API. When migrating earlier builder examples, replace `MySQL.table` and `MySQL.op` and add the builder import.

## Supported API

- `Builder.table(name)` starts a SELECT with all columns selected by default.
- `:select({ 'id', 'name' })` selects a non-empty dense array of column identifiers. Omit this call to select all columns; `:select('*')` is unsupported.
- `:where(predicate)` adds a predicate. Repeated calls combine with AND.
- `:limit(number)` sets a non-negative safe integer limit, including zero.
- `:get(callback?)` returns a list of rows.
- `:first(callback?)` returns one row or `nil`. It caps the limit at one and preserves an explicit zero limit.
- `Builder.op.eq(column, value)` creates an equality predicate.
- `Builder.op.inArray(column, values)` creates an IN predicate from a dense array. An empty array matches no rows.
- `Builder.op.allOf(...)` combines one or more predicates with AND.

Use dot syntax for `Builder.table` and operator constructors, and colon syntax for chain methods. Chain methods return new builders; retain their return values. A base builder can be reused without accumulating filters or limits from derived queries.

```lua
local op = Builder.op
local base = Builder.table('users')

local staff = base
    :select({ 'id', 'name' })
    :where(op.eq('active', true))
    :where(op.inArray('role', { 'admin', 'moderator' }))
    :limit(10)
    :get()

local user = base:where(op.eq('id', userId)):first()

local matching = base:where(op.allOf(
    op.eq('active', true),
    op.eq('role', 'admin')
)):get()
```

## Execution and errors

Without a callback, `:get()` and `:first()` await internally and return results directly. Call them from a FiveM context that can yield, such as a thread or a suitable server handler. Do not append `.await` to builder methods.

With a callback, results are delivered to the callback:

```lua
Builder.table('users'):where(Builder.op.eq('id', userId)):first(function(user)
    if user then
        print(user.name)
    end
end)
```

Awaited execution errors reject and can be handled with `pcall`. Obvious API misuse throws locally before export dispatch. Callback execution errors are logged by default. A resource declaring `mysql_option 'return_callback_errors'` also receives execution errors as the callback's second argument, `(result, error)`. Keep that option consistent with the resource's existing error handling.

## Values and identifiers

Values must be non-null strings, booleans, or finite numbers. `false` and zero are valid. Do not pass `nil`, tables, functions, NaN, or infinity as scalar values. IN arrays must be dense and contain supported scalar values.

Table and column names are validated dot-separated identifiers, such as `users.id`; the compiler quotes each segment. Empty segments, wildcards, control characters, and `?` are rejected. Choose identifiers from application code or an allowlist. Supply user input as predicate values; never interpolate it into SQL or identifier names.

## Unsupported queries

The current builder has no insert, update, delete, ordering, offset, joins, aggregates, aliases, distinct, raw expressions, null checks, OR/NOT groups, or comparison operators beyond `eq` and `inArray`. There is no public JavaScript/TypeScript builder or PostgreSQL support.

For those operations, use the existing parameterized `MySQL` functions unless the user explicitly asks to extend the builder. For example:

```lua
local changed = MySQL.update.await(
    'UPDATE users SET active = ? WHERE id = ?',
    { false, userId }
)
```

## Working in the oxmysql source checkout

Treat `lib/Builder.lua` and `src/query-builder/` as the implementation authority. The [POC plan](../../docs/query-builder-poc-plan.md) describes the implemented subset; the [full specification](../../docs/query-builder-spec.md) also describes future features.

When extending the implementation, keep Lua builders and operators local to the consuming resource. Only plain query specifications cross the dedicated `queryBuilder` export. SQL compilation belongs in the TypeScript compiler, and execution uses the existing raw-query path. Preserve existing `MySQL` signatures, compatibility aliases, parameter binding, invoking-resource attribution, and callback/promise error behavior.

Relevant checks are `tests/lua/query-builder.test.lua` for the Lua facade and `tests/unit/query-builder/` for compilation and execution. The POC plan documents the available validation tasks. Distinguish mocked contract checks from live FiveM/MySQL validation when reporting results.
