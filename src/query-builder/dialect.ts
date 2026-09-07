export interface QueryDialect {
  readonly name: 'mysql' | 'postgresql';
  placeholder(position: number): string;
  quoteIdentifierPart(part: string): string;
}