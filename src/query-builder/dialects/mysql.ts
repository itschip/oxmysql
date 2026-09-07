import type { QueryDialect } from '../dialect';

export const mysqlDialect: QueryDialect = {
  name: 'mysql',
  placeholder: (_position) => '?',
  quoteIdentifierPart: (part) => `\`${part.replace(/`/g, '``')}\``,
};