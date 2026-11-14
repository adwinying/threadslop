import { t } from 'elysia'

/** Which Items a request covers: Messages (the default) or every Item. */
export const itemScopeSchema = t.UnionEnum(['messages', 'all'], {
  default: 'messages',
})

export type ItemScope = typeof itemScopeSchema.static

/** Filters `items` aliased `i` to the scope; bind `$all` to `scope === 'all'`. */
export const inScope = `($all OR i.type IN ('user_message', 'assistant_message'))`
