export interface Identifier {
  readonly kind: 'identifier';
  readonly parts: readonly string[];
}

export type Predicate =
  | { readonly kind: 'comparison'; readonly operator: 'eq'; readonly column: Identifier; readonly value: unknown }
  | { readonly kind: 'collection'; readonly operator: 'inArray'; readonly column: Identifier; readonly values: readonly unknown[] }
  | { readonly kind: 'group'; readonly operator: 'allOf'; readonly predicates: readonly Predicate[] };

export interface SelectSpec {
  readonly kind: 'select';
  readonly from: Identifier;
  readonly columns: readonly Identifier[] | '*';
  readonly where?: Predicate;
  readonly limit?: number;
}

export type QuerySpec = SelectSpec;
export type BuilderResultMode = 'query' | 'single';

export interface CompiledQuery {
  sql: string;
  parameters: unknown[];
}