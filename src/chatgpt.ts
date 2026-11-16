import type { Fetch } from '~/web'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createRequest, parseOrThrow, saveSessionStore } from '~/web'

// Everything about chatgpt.com's undocumented backend API lives in this
// module. Its shapes were checked against real responses in the spike (#36),
// not documented, so a shape that doesn't match fails the read instead of
// saving half a chat.

/** The Source label ChatGPT Threads are archived under. */
export const chatgptLabel = 'chatgpt'

/** The web URL of a ChatGPT chat, by Thread ID. */
export const chatgptChatUrl = (threadId: string) =>
  `https://chatgpt.com/c/${threadId}`

/**
 * The next-auth cookie holding the session. A browser may hold it split into
 * `.0` and `.1` parts; next-auth joins every cookie with this prefix, so the
 * parts joined under this name sign in too.
 */
export const sessionCookie = '__Secure-next-auth.session-token'

const sessionSchema = z.object({
  cookies: z.record(z.string(), z.string()),
})

export type ChatGPTSession = z.infer<typeof sessionSchema>

const sessionFile = (dataDir: string) => join(dataDir, 'chatgpt-session.json')

/** ChatGPT is a Source only while its session store exists. */
export const hasChatGPTSession = (dataDir: string) =>
  existsSync(sessionFile(dataDir))

export const saveChatGPTSession = (
  dataDir: string,
  session: ChatGPTSession,
) => {
  saveSessionStore(sessionFile(dataDir), session)
}

const loadSession = (dataDir: string) =>
  sessionSchema.parse(JSON.parse(readFileSync(sessionFile(dataDir), 'utf8')))

const origin = 'https://chatgpt.com'

/** Fails a response that isn't OK, naming Cloudflare when it challenged. */
const ensureOk = async (response: Response, path: string) => {
  if (response.ok) return
  // Cloudflare marks a challenge with the header; the page's script marks one
  // sent without it.
  const challenged =
    response.headers.get('cf-mitigated') === 'challenge' ||
    (await response.text()).includes('/cdn-cgi/challenge-platform/')
  if (challenged) {
    throw new Error(
      `Cloudflare challenged ${path} with HTTP ${response.status}`,
    )
  }
  throw new Error(`ChatGPT answered ${path} with HTTP ${response.status}`)
}

// next-auth answers a signed-out session with `{}`.
const authSessionSchema = z.object({ accessToken: z.string().optional() })

/**
 * Exchanges the session cookie for a short-lived access token. Resolves with
 * undefined when signed out; throws on any other failure, which signing in
 * again wouldn't fix.
 */
const signIn = async (request: ReturnType<typeof createRequest>) => {
  const path = '/api/auth/session'
  const response = await request(`${origin}${path}`)
  await ensureOk(response, path)
  return authSessionSchema.parse(await response.json()).accessToken
}

/**
 * Runs the sign-in check on cookies not yet stored. Resolves with the cookies
 * to store, including any ChatGPT set meanwhile, or undefined when signed out.
 */
export const checkChatGPTSignIn = async ({
  cookies,
  fetch,
}: {
  cookies: Record<string, string>
  fetch: Fetch
}) => {
  const jar = new Map(Object.entries(cookies))
  const accessToken = await signIn(createRequest({ jar, fetch }))
  return accessToken === undefined ? undefined : Object.fromEntries(jar)
}

const chatsPerPage = 100

const listPageSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        // The list gives ISO times; a conversation gives epoch seconds.
        update_time: z.iso.datetime(),
      })
      .transform(({ id, title, update_time }) => ({
        threadId: id,
        title,
        updatedAt: new Date(update_time),
      })),
  ),
})

/** Epoch seconds, as a conversation gives its times. */
const epochSchema = z.number().transform((seconds) => new Date(seconds * 1000))

const messageSchema = z.object({
  id: z.string(),
  author: z.object({ role: z.string() }),
  create_time: epochSchema.nullable(),
  content: z.object({ content_type: z.string() }).loose(),
  /** `all`, or the tool an assistant message calls. */
  recipient: z.string(),
  metadata: z
    .object({ is_visually_hidden_from_conversation: z.boolean().optional() })
    .loose(),
})

type ChatGPTMessage = z.infer<typeof messageSchema>

const conversationSchema = z.object({
  create_time: epochSchema,
  current_node: z.string(),
  mapping: z.record(
    z.string(),
    z.object({
      message: messageSchema.nullable(),
      parent: z.string().nullable(),
    }),
  ),
})

/**
 * The messages the ChatGPT UI shows, oldest first: the current node up through
 * its parents. Regenerations off that branch are left out.
 */
const visibleBranch = ({
  current_node,
  mapping,
}: z.infer<typeof conversationSchema>) => {
  const messages: ChatGPTMessage[] = []
  const seen = new Set<string>()
  let id: string | null = current_node
  while (id !== null) {
    const node: (typeof mapping)[string] | undefined = mapping[id]
    // Guards against walking forever: Syncs never overlap, so one stuck read
    // would stall every Source.
    if (node === undefined || seen.has(id)) {
      throw new Error(`its branch breaks at node ${id}`)
    }
    seen.add(id)
    if (node.message !== null) messages.push(node.message)
    id = node.parent
  }
  return messages.toReversed()
}

const textSchema = z.object({ parts: z.array(z.string()) })

/**
 * An image as a Markdown placeholder holding its bare file ID, so a later
 * route can resolve it without re-reading the chat. Uploads point at
 * `file-service://file-…`, generated and pasted images at `sediment://file_…`.
 */
const imageSchema = z
  .object({
    content_type: z.literal('image_asset_pointer'),
    asset_pointer: z.string().regex(/^[\w-]+:\/\/./),
  })
  .transform(
    ({ asset_pointer }) =>
      `![image](chatgpt-file:${asset_pointer.split('://')[1]})`,
  )

// Dropped like an unknown content type, so a new kind of part, such as audio,
// doesn't fail every later Sync.
const unknownPartSchema = z
  .looseObject({
    content_type: z.string().refine((type) => type !== 'image_asset_pointer'),
  })
  .transform(() => null)

/** A message's text and images, one part per line. */
const multimodalSchema = z
  .object({
    parts: z.array(z.union([z.string(), imageSchema, unknownPartSchema])),
  })
  .transform(({ parts }) => parts.filter((part) => part !== null).join('\n'))

/** A tool call or result's text: text parts, or code and its output. */
const toolTextSchema = z.union([
  textSchema.transform(({ parts }) => parts.join('\n')),
  z.object({ text: z.string() }).transform(({ text }) => text),
])

// A web call leaves its text empty and names its queries here.
const searchQueriesSchema = z.object({
  search_queries: z.array(z.object({ q: z.string() })).optional(),
})

/** What a tool call sent: its text, or the queries a web call ran. */
const toolInput = (call: ChatGPTMessage) =>
  toolTextSchema.parse(call.content) ||
  (searchQueriesSchema.parse(call.metadata).search_queries ?? [])
    .map(({ q }) => q)
    .join('\n')

const sourceSchema = z.object({ url: z.string(), title: z.string().optional() })

/** The pages a search returned, listed beside a web call's result or reply. */
const searchResultGroupsSchema = z
  .array(z.object({ entries: z.array(sourceSchema) }))
  .default([])

// A web call's result leaves its text empty and lists its pages here.
const webResultsSchema = z
  .object({ search_result_groups: searchResultGroupsSchema })
  .transform(({ search_result_groups }) =>
    search_result_groups
      .flatMap(({ entries }) => entries)
      .flatMap(({ url, title }) => (title === undefined ? [url] : [title, url]))
      .join('\n'),
  )

/**
 * What the tool answered, from the results' texts or the pages a web call
 * found, or null when none has either. Images are left to the results
 * themselves.
 */
const toolOutput = (results: ChatGPTMessage[]) =>
  results
    .filter(({ metadata }) => !metadata.is_visually_hidden_from_conversation)
    .map(
      ({ content, metadata }) =>
        toolTextSchema.safeParse(content).data ||
        webResultsSchema.safeParse(metadata).data,
    )
    .filter(Boolean)
    .join('\n') || null

const thoughtsSchema = z.object({
  thoughts: z.array(z.object({ summary: z.string(), content: z.string() })),
})

/**
 * The content references that cite the web, each as its marker in the reply
 * and the sources it cites. Markers are private-use characters, never `【…】`,
 * which is real text.
 */
const citationSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('hidden'), matched_text: z.string() })
    .transform(({ matched_text }) => ({ marker: matched_text, sources: [] })),
  z
    .object({
      type: z.literal('grouped_webpages'),
      matched_text: z.string(),
      items: z.array(sourceSchema),
    })
    .transform(({ matched_text, items }) => ({
      marker: matched_text,
      sources: items,
    })),
  z
    .object({
      type: z.literal('webpage'),
      matched_text: z.string(),
      ...sourceSchema.shape,
    })
    .transform(({ matched_text, url, title }) => ({
      marker: matched_text,
      sources: [{ url, title }],
    })),
  // Its marker is a space ending the reply, not a citation, so it strips
  // nothing.
  z
    .object({
      type: z.literal('sources_footnote'),
      sources: z.array(sourceSchema),
    })
    .transform(({ sources }) => ({ marker: '', sources })),
])

const citationTypes = new Set<string>(
  citationSchema.options.map((option) => option.in.shape.type.value),
)

/**
 * Any other reference but an attribution marks up something the UI renders in
 * its place, such as an entity's name or a product card, so it shows as its
 * alt text, or as nothing without one. An attribution marks the reply's own
 * prose, so it stays.
 */
const renderedSchema = z
  .object({ matched_text: z.string(), alt: z.string().nullish() })
  .transform(({ matched_text, alt }) => ({
    marker: matched_text,
    shown: alt ?? '',
    sources: [],
  }))

const referencesSchema = z.object({
  content_references: z
    .array(z.looseObject({ type: z.string() }))
    .default([])
    .transform((references) =>
      references
        .filter(({ type }) => type !== 'attribution')
        .map((reference) =>
          citationTypes.has(reference.type)
            ? { ...citationSchema.parse(reference), shown: '' }
            : renderedSchema.parse(reference),
        ),
    ),
  // Older replies cite without URLs, so their sources are what they searched.
  search_result_groups: searchResultGroupsSchema,
})

/**
 * A marker with plain hyphens and spaces. A reference may list a no-break
 * hyphen or space where the reply has a plain one.
 */
const plainSpaced = (marker: string) =>
  marker.replaceAll('\u2011', '-').replaceAll(/[\u00a0\u202f]/g, ' ')

/**
 * A reply's text as the UI shows it, without citation markers, and the web
 * sources it cites.
 */
const citedReply = (text: string, metadata: unknown) => {
  const { content_references, search_result_groups } =
    referencesSchema.parse(metadata)
  const cited = [
    ...content_references.flatMap(({ sources }) => sources),
    ...search_result_groups.flatMap(({ entries }) => entries),
  ]
  return {
    text: content_references.reduce(
      // An empty marker marks no span; replacing it would insert between
      // every character.
      (shownText, { marker, shown }) =>
        marker === ''
          ? shownText
          : shownText
              .replaceAll(marker, shown)
              .replaceAll(plainSpaced(marker), shown),
      text,
    ),
    // Each source once, where it's first cited.
    sources: cited.filter(
      ({ url }, index) =>
        cited.findIndex((source) => source.url === url) === index,
    ),
  }
}

/**
 * The Items a message on the visible branch becomes, by what it holds. One the
 * conversation hides becomes none. A tool call takes its output from `results`,
 * the tool messages right after it.
 */
const toItemDrafts = (message: ChatGPTMessage, results: ChatGPTMessage[]) => {
  if (message.metadata.is_visually_hidden_from_conversation) return []
  const { role } = message.author
  const { content_type } = message.content

  if (
    content_type === 'text' &&
    message.recipient === 'all' &&
    (role === 'user' || role === 'assistant')
  ) {
    const { text, sources } = citedReply(
      textSchema.parse(message.content).parts.join('\n'),
      message.metadata,
    )
    return [
      // A reply that only called the web is empty.
      ...(text === '' ? [] : [{ type: `${role}_message`, payload: { text } }]),
      ...(sources.length === 0
        ? []
        : [{ type: 'web_sources', payload: { sources } }]),
    ]
  }

  if (content_type === 'thoughts') {
    const text = thoughtsSchema
      .parse(message.content)
      .thoughts.flatMap(({ summary, content }) => [`**${summary}**`, content])
      .join('\n\n')
    return [{ type: 'reasoning', payload: { text } }]
  }

  // Images come in a user message, or for a generated image in the image
  // tool's message, which the UI shows as ChatGPT's reply.
  if (
    content_type === 'multimodal_text' &&
    message.recipient === 'all' &&
    (role === 'user' || role === 'tool')
  ) {
    const text = multimodalSchema.parse(message.content)
    const type = role === 'user' ? 'user_message' : 'assistant_message'
    return text === '' ? [] : [{ type, payload: { text } }]
  }

  if (role === 'assistant' && message.recipient === 'python') {
    return [
      {
        type: 'command_execution',
        payload: { input: toolInput(message), output: toolOutput(results) },
      },
    ]
  }

  // Memory writes (`bio`) stay out, like the memory context they update.
  if (role === 'assistant' && !['all', 'bio'].includes(message.recipient)) {
    return [
      {
        type: 'dynamic_tool',
        payload: {
          toolName: message.recipient,
          input: toolInput(message),
          output: toolOutput(results),
        },
      },
    ]
  }

  // Not shown as a Message: system, memory and context messages, and tool
  // results, which their calls hold.
  return []
}

/** The tool messages right after a message on the branch: a call's results. */
const resultsAfter = (branch: ChatGPTMessage[], index: number) => {
  const after = branch.slice(index + 1)
  const end = after.findIndex(({ author }) => author.role !== 'tool')
  return end === -1 ? after : after.slice(0, end)
}

/** A conversation's start, and the Item drafts of its visible branch in order. */
const parseChat = (body: unknown) => {
  const conversation = conversationSchema.parse(body)
  const branch = visibleBranch(conversation)
  return {
    createdAt: conversation.create_time,
    drafts: branch.flatMap((message, index) =>
      toItemDrafts(message, resultsAfter(branch, index)).map((draft) => ({
        ...draft,
        key: message.id,
        at: message.create_time ?? conversation.create_time,
      })),
    ),
  }
}

/** What reaching ChatGPT with the stored session takes. */
export type ChatGPTCollaborators = {
  dataDir: string
  fetch: Fetch
  /** Milliseconds between requests, so traffic looks like a person browsing. */
  pace: number
}

/**
 * Signs in to ChatGPT with the stored session. Throws when the session no
 * longer signs in.
 */
export const connectChatGPT = async ({
  dataDir,
  fetch,
  pace,
}: ChatGPTCollaborators) => {
  const jar = new Map(Object.entries(loadSession(dataDir).cookies))
  // Saved at once: ChatGPT may already reject the cookies they replace.
  const request = createRequest({
    jar,
    fetch,
    pace,
    onSetCookies: () => {
      saveChatGPTSession(dataDir, { cookies: Object.fromEntries(jar) })
    },
  })

  const accessToken = await signIn(request)
  if (accessToken === undefined) {
    throw new Error('signed out; run install-chatgpt')
  }

  const getJson = async (path: string, query = '') => {
    const response = await request(`${origin}${path}${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    await ensureOk(response, path)
    return response.json()
  }

  return {
    /** One page of chats, most recently updated first. */
    listChats: async ({
      offset,
      archived,
    }: {
      offset: number
      archived: boolean
    }) => {
      const query = new URLSearchParams({
        offset: String(offset),
        limit: String(chatsPerPage),
        order: 'updated',
        is_archived: String(archived),
      })
      const body = await getJson('/backend-api/conversations', `?${query}`)
      const { items } = parseOrThrow("ChatGPT's chat list", () =>
        listPageSchema.parse(body),
      )
      return {
        chats: items,
        // A short page is the last.
        nextOffset:
          items.length < chatsPerPage ? undefined : offset + items.length,
      }
    },

    /** A chat's start, and the Item drafts of its visible branch in order. */
    readChat: async (threadId: string) => {
      const body = await getJson(`/backend-api/conversation/${threadId}`)
      return parseOrThrow(`ChatGPT chat ${threadId}`, () => parseChat(body))
    },
  }
}
