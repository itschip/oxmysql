---
name: oxmysql-query-builder
description: "Design, implement, test, or review the oxmysql Lua query builder, SQL AST/compiler, MySQL or PostgreSQL dialects, execution bridge, and database driver adapters while preserving existing exports. Use for Lua query-builder features, SQL generation, dialect work, or PostgreSQL preparation."
argument-hint: "Describe the query-builder feature, dialect change, or compatibility issue"
---
# OxMySQL Query Builder

Use this workflow for query-builder and multi-database work in oxmysql.

## Source of truth

Read [the query builder specification](../../../docs/query-builder-spec.md). Treat its compatibility contract, architecture boundaries, security requirements, and phased rollout as requirements. If implementation needs to depart from the specification, update the specification in the same change and explain why.

## Workflow

1. Identify the smallest affected layer:
   - Lua builder facade for fluent ergonomics and spec construction.
   - Query specification for serializable intent.
   - Compiler for validation, parameter ordering, and statement assembly.
   - Query dialect for quoting, placeholders, and syntax differences.
   - Execution bridge for routing compiled SQL through existing result modes.
   - Database driver adapter for pools, result normalization, type casting, profiling, and backend behavior.
2. Read the owning implementation and one nearby test. State the expected SQL, parameters, result mode, and compatibility behavior before editing.
3. Make the smallest change in one layer. Do not mix compiler features with unrelated driver refactors.
4. Add or update focused tests immediately:
   - Compiler work: exact SQL and ordered parameters.
   - Facade work: exact plain-data query specification.
   - Execution work: selected raw execution path and result mode.
   - Dialect work: shared fixtures across every supported dialect.
   - Driver work: normalized results plus real-database integration coverage.
5. Run the narrowest relevant tests, then the complete unit suite when shared compiler or execution behavior changes.
6. Review the compatibility and security checklists before finishing.

## Design rules

- Existing SQL-string APIs remain valid and bypass builder compilation.
- The Lua facade produces plain serializable data; it does not generate dialect SQL.
- Do not add a public TypeScript or JavaScript builder facade in the first version. The existing `lib/MySQL.ts` raw-query API remains unchanged.
- Model predicates as functions under `MySQL.op`, inspired by Drizzle: functions such as `eq`, `inArray`, and `isNull` return plain predicate tables consumed by `where` or `having`.
- Use `allOf`, `anyOf`, and `not_` as Lua-safe boolean combinators. Public APIs must not accept arbitrary SQL operator strings.
- The compiler is deterministic and has no FiveM, configuration, logging, pool, or driver dependencies.
- Dialects render SQL. Drivers execute SQL and normalize backend behavior. Do not combine these abstractions.
- Values always become parameters. Identifiers are validated, segmented, and dialect-quoted.
- Operators and SQL keywords accepted from APIs use closed allowlists.
- Update and delete require a predicate unless `allowAll()` is explicit.
- Invalid specifications fail before acquiring a connection.
- Prefer a concrete MySQL implementation over speculative generic abstractions. Generalize against shared PostgreSQL fixtures when that dialect is introduced.

## Compatibility checklist

- Existing `query`, `single`, `scalar`, `update`, `insert`, `prepare`, `rawExecute`, and `transaction` calls retain signatures and results.
- Callback, promise, `.await`, `_async`, and deprecated `Sync` behavior remains intact.
- Stored query references continue to work.
- `ghmattimysql` and `mysql-async` aliases remain unchanged.
- Named placeholders and positional placeholders in raw SQL retain current behavior.
- Invoking-resource attribution, logging, profiling, and transaction rollback are preserved.
- Builder objects never cross the FiveM export boundary; only plain specifications do.
- The Lua facade creates the documented query specification shape and leaves compilation to oxmysql.

## Security checklist

- No value interpolation into SQL.
- No unchecked operator, direction, join kind, aggregate, or raw fragment.
- Identifier quote characters are escaped by the dialect.
- Null and empty-list semantics are covered by tests.
- Empty inserts and updates are rejected.
- Unbounded mutations require explicit opt-in and a regression test.
- Errors do not expose connection credentials.

## PostgreSQL readiness

When adding PostgreSQL, first compile shared query specifications with both dialects. Then inventory mysql2 assumptions in configuration, pool, connection, raw execution, response parsing, type casting, validation, and profiling. Extract a database-driver contract from those real differences; do not model PostgreSQL as only a placeholder and identifier-quoting change.