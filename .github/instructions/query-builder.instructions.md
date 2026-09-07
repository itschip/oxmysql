---
name: "OxMySQL Query Builder"
description: "Use when implementing or reviewing the oxmysql Lua query builder, SQL compiler, query dialects, database driver strategies, execution bridge, or PostgreSQL support."
applyTo: ["src/query-builder/**/*.ts", "src/dialects/**/*.ts", "src/drivers/**/*.ts", "lib/MySQL.lua", "tests/unit/query-builder/**/*.ts", "tests/unit/dialects/**/*.ts", "docs/query-builder*.md"]
---
# Query Builder Guidelines

- Read [the query builder specification](../../docs/query-builder-spec.md) before changing the builder contract or architecture.
- Preserve every existing raw SQL export and return shape. The builder is additive; do not route SQL strings through the builder compiler.
- Keep query specifications serializable across the FiveM boundary. Do not put functions, prototypes, class instances, or driver objects in them.
- Keep the compiler pure. It accepts a query specification and query dialect, and returns SQL plus positional parameters without reading globals or opening connections.
- Keep SQL rendering in query dialects. Keep pools, result normalization, type casting, profiling, and connection options in database driver adapters.
- Parameterize values and quote validated identifier segments. Use allowlists for operators, sort directions, join kinds, and aggregate functions.
- Expose predicates as Lua functions under `MySQL.op`, following the Drizzle-style expression model: `eq`, `inArray`, `isNull`, `allOf`, and related helpers return plain predicate tables.
- Do not accept raw SQL operator strings in the public builder API. Use internal discriminants that the compiler maps to dialect SQL.
- Use `allOf`, `anyOf`, and `not_` for boolean composition because `and`, `or`, and `not` are reserved Lua keywords.
- Reject unbounded updates and deletes unless the caller explicitly opts in with `allowAll()`.
- Compile and validate before acquiring a connection.
- Add exact SQL and parameter assertions for each compiler behavior. Add regression tests whenever an existing execution or compatibility path is touched.
- Keep Lua as the only public builder facade for the first version. Do not add builder methods to `lib/MySQL.ts`.
- Compile SQL once inside oxmysql rather than duplicating dialect logic in Lua.
- Implement the smallest specification phase needed. Do not extract a generic database driver until a real PostgreSQL integration requires it.