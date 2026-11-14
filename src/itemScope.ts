import { t } from 'elysia'

/** Which Items a request covers: Messages (the default) or every Item. */
export const itemScopeSchema = t.UnionEnum(['messages', 'all'], {
  default: 'messages',
})

export type ItemScope = typeof itemScopeSchema.static

/** The Item types that count as Messages, with the role of their author. */
const messageRoles = new Map<string, 'user' | 'assistant'>([
  ['user_message', 'user'],
  ['assistant_message', 'assistant'],
])

/** The role of a Message's author, or null for other Items. */
export const roleOf = (type: string) => messageRoles.get(type) ?? null

/** Filters `items` aliased `i` to the scope; bind `$all` to `scope === 'all'`. */
export const inScopeSql = `($all OR i.type IN (${[...messageRoles.keys()]
  .map((type) => `'${type}'`)
  .join(', ')}))`
