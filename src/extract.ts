import { z } from 'zod'

/** Tool inputs and outputs vary per tool, so they're indexed as JSON. */
const toText = (value: unknown) => {
  if (typeof value === 'string') return value
  return value == null ? '' : JSON.stringify(value)
}

const messageText = z.object({ text: z.string() }).transform(({ text }) => text)

const extractors = new Map<string, z.ZodType<string, unknown>>([
  ['user_message', messageText],
  ['assistant_message', messageText],
  ['reasoning', messageText],
  [
    'command_execution',
    z
      .object({ input: z.string(), output: z.string().nullish() })
      .transform(({ input, output }) => `${input}\n${output ?? ''}`),
  ],
  [
    'dynamic_tool',
    z
      .object({ toolName: z.string(), input: z.unknown(), output: z.unknown() })
      .transform(({ toolName, input, output }) =>
        [toolName, toText(input), toText(output)].join('\n'),
      ),
  ],
  [
    'file_change',
    z
      .object({
        fileName: z.string(),
        changes: z.array(z.object({ path: z.string() })).nullish(),
        diffStr: z.string(),
      })
      .transform(({ fileName, changes, diffStr }) =>
        [
          ...new Set([fileName, ...(changes ?? []).map(({ path }) => path)]),
          diffStr,
        ].join('\n'),
      ),
  ],
  [
    'web_search',
    z
      .object({ patterns: z.array(z.string()) })
      .transform(({ patterns }) => patterns.join(' ')),
  ],
])

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The text indexed for search, chosen by Item type. Unknown types, and
 * payloads that aren't JSON or whose shape T3 has since changed, fall back to
 * the raw payload.
 */
export const extractSearchText = (type: string, payload: string) => {
  const extracted = extractors.get(type)?.safeParse(parseJson(payload))
  return extracted?.success ? extracted.data : payload
}
