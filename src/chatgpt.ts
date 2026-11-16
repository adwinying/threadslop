import type { Fetch } from '~/web'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createRequest, saveSessionStore } from '~/web'

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

/** A chat as the list reports it. */
export type ListedChat = z.infer<typeof listPageSchema>['items'][number]

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

type Message = z.infer<typeof messageSchema>

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
  const messages: Message[] = []
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

/** An Item a message becomes, before its Thread numbers it. */
type ItemDraft = { type: string; payload: object }

/**
 * The Items a message on the visible branch becomes, by what it holds. One the
 * conversation hides becomes none.
 */
const toItemDrafts = (message: Message): ItemDraft[] => {
  if (message.metadata.is_visually_hidden_from_conversation) return []
  const { role } = message.author
  const { content_type } = message.content

  if (
    content_type === 'text' &&
    message.recipient === 'all' &&
    (role === 'user' || role === 'assistant')
  ) {
    const text = textSchema.parse(message.content).parts.join('\n')
    // A turn that only called the web leaves an empty reply.
    return text === '' ? [] : [{ type: `${role}_message`, payload: { text } }]
  }

  // Not shown as a Message: system, memory and context messages, and tool
  // calls with their results.
  return []
}

/** A conversation's start, and the Item drafts of its visible branch in order. */
const parseChat = (body: unknown) => {
  const conversation = conversationSchema.parse(body)
  return {
    createdAt: conversation.create_time,
    drafts: visibleBranch(conversation).flatMap((message) =>
      toItemDrafts(message).map((draft) => ({
        ...draft,
        messageId: message.id,
        at: message.create_time,
      })),
    ),
  }
}

export type Chat = ReturnType<typeof parseChat>

/** Runs a parser, naming what didn't parse when ChatGPT's format changed. */
const parseOrThrow = <T>(what: string, parse: () => T) => {
  try {
    return parse()
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause
    const detail =
      cause instanceof z.ZodError ? z.prettifyError(cause) : cause.message
    throw new Error(`${what} didn't parse: ${detail}`, { cause })
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
