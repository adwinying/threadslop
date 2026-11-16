import type { Fetch } from '~/web'
import { saveChatGPTSession, sessionCookie } from '~/chatgpt'

const token = 'fake-session-token'
const accessToken = 'fake-access-token'

export type NodeFixture = {
  /** The node's ID, which its message shares. */
  id: string
  /** Defaults to the node listed before it, or the root for the first. */
  parent?: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** The author's name, e.g. the tool a tool message comes from. */
  name?: string
  /** The message's text, as its one part. */
  text?: string
  /** Replaces the text content, e.g. with thoughts or an image. */
  content?: Record<string, unknown>
  /** Who the message is for: `all`, or the tool an assistant calls. */
  recipient?: string
  metadata?: Record<string, unknown>
  /** ISO time the message was written. */
  at: string
}

export type ChatFixture = {
  id: string
  title: string
  /** ISO time the chat started; defaults to `updatedAt`. */
  createdAt?: string
  /** ISO time of the chat's last update, as the list reports it. */
  updatedAt: string
  archived?: boolean
  /** The custom GPT the chat is with. */
  gizmoId?: string
  /** The chat's messages; each follows the one before unless it names a parent. */
  nodes?: NodeFixture[]
  /** The node the ChatGPT UI shows last; defaults to the last node. */
  currentNode?: string
}

export type ListRequest = {
  offset: number
  limit: number
  order: string | null
  archived: boolean
}

const listedChat = ({
  id,
  title,
  createdAt,
  updatedAt,
  archived,
  gizmoId,
}: ChatFixture) => ({
  id,
  title,
  create_time: createdAt ?? updatedAt,
  update_time: updatedAt,
  mapping: null,
  current_node: null,
  conversation_template_id: null,
  gizmo_id: gizmoId ?? null,
  is_archived: archived ?? false,
  workspace_id: null,
})

/** Epoch seconds, as a conversation gives its times. */
const toEpoch = (iso: string) => Date.parse(iso) / 1000

const rootId = 'client-created-root'

const toMessage = ({
  id,
  role,
  name,
  text,
  content,
  recipient,
  metadata,
  at,
}: NodeFixture) => ({
  id,
  author: { role, name: name ?? null, metadata: {} },
  create_time: toEpoch(at),
  update_time: null,
  content: content ?? { content_type: 'text', parts: [text ?? ''] },
  status: 'finished_successfully',
  end_turn: role === 'assistant' ? true : null,
  weight: 1,
  metadata: metadata ?? {},
  recipient: recipient ?? 'all',
  channel: null,
})

/** A conversation as chatgpt.com sends it: a tree of nodes under a root. */
const conversation = (chat: ChatFixture) => {
  const nodes = chat.nodes ?? []
  const parentOf = (node: NodeFixture, index: number) =>
    node.parent ?? nodes[index - 1]?.id ?? rootId
  const childrenOf = (id: string) =>
    nodes
      .filter((node, index) => parentOf(node, index) === id)
      .map((node) => node.id)
  return {
    title: chat.title,
    create_time: toEpoch(chat.createdAt ?? chat.updatedAt),
    update_time: toEpoch(chat.updatedAt),
    mapping: Object.fromEntries([
      [
        rootId,
        {
          id: rootId,
          message: null,
          parent: null,
          children: childrenOf(rootId),
        },
      ],
      ...nodes.map((node, index) => [
        node.id,
        {
          id: node.id,
          message: toMessage(node),
          parent: parentOf(node, index),
          children: childrenOf(node.id),
        },
      ]),
    ]),
    moderation_results: [],
    current_node: chat.currentNode ?? nodes.at(-1)?.id ?? rootId,
    conversation_id: chat.id,
    gizmo_id: chat.gizmoId ?? null,
    is_archived: chat.archived ?? false,
    default_model_slug: 'gpt-5',
  }
}

/**
 * A `fetch` that answers like chatgpt.com, from fixtures. Any other request
 * fails, so tests never reach chatgpt.com.
 */
export const createFakeChatGPT = () => {
  // The cookies chatgpt.com accepts: the latest it set for each name.
  const accepted = new Map([[sessionCookie, token]])
  const chats = new Map<string, ChatFixture>()
  let listRequests: ListRequest[] = []
  let reads: string[] = []
  const failedReads = new Map<string, number>()
  let unsent: [name: string, value: string][] = []
  let signedIn = true
  let challenged: { path: string; header: boolean } | undefined
  let sessionStatus: number | undefined

  const hasSessionCookies = (header: string) =>
    [...accepted].every(([name, value]) =>
      header.split('; ').includes(`${name}=${value}`),
    )

  /** A response that sets the cookies not yet sent, which replace the old. */
  const respond = (body: BodyInit | null, init: ResponseInit = {}) => {
    const headers = new Headers(init.headers)
    for (const [name, value] of unsent) {
      accepted.set(name, value)
      headers.append(
        'Set-Cookie',
        `${name}=${value}; Path=/; Expires=Mon, 15-Nov-2027 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`,
      )
    }
    unsent = []
    return new Response(body, { ...init, headers })
  }

  const respondJson = (body: unknown) =>
    respond(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    })

  const fetch: Fetch = async (url, init) => {
    const { origin, pathname, searchParams } = new URL(url)
    if (origin !== 'https://chatgpt.com') {
      throw new Error(`fake ChatGPT has no route for ${url}`)
    }
    if (challenged !== undefined && pathname.startsWith(challenged.path)) {
      // What Cloudflare sends a client it won't let through.
      return respond(
        '<!DOCTYPE html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>',
        {
          status: 403,
          headers: {
            'Content-Type': 'text/html',
            ...(challenged.header && { 'cf-mitigated': 'challenge' }),
          },
        },
      )
    }
    const cookieHeader = new Headers(init.headers).get('Cookie') ?? ''
    const authorized = signedIn && hasSessionCookies(cookieHeader)

    if (pathname === '/api/auth/session') {
      if (sessionStatus !== undefined) {
        return respond(null, { status: sessionStatus })
      }
      // next-auth answers a signed-out session with an empty object.
      return respondJson(
        authorized
          ? {
              user: { id: 'user-fake', name: 'Adwin' },
              expires: '2027-02-14T00:00:00.000Z',
              accessToken,
            }
          : {},
      )
    }

    const bearer = new Headers(init.headers).get('Authorization')
    const authorizedApi = authorized && bearer === `Bearer ${accessToken}`

    const readId = pathname.match(/^\/backend-api\/conversation\/([^/]+)$/)?.[1]
    if (readId !== undefined) {
      if (!authorizedApi) return respond(null, { status: 401 })
      reads.push(readId)
      const status = failedReads.get(readId)
      if (status !== undefined) {
        failedReads.delete(readId)
        return respond(null, { status })
      }
      const chat = chats.get(readId)
      return chat === undefined
        ? respond(null, { status: 404 })
        : respondJson(conversation(chat))
    }

    if (pathname === '/backend-api/conversations') {
      if (!authorizedApi) return respond(null, { status: 401 })
      const offset = Number(searchParams.get('offset'))
      const limit = Number(searchParams.get('limit'))
      const archived = searchParams.get('is_archived') === 'true'
      listRequests.push({
        offset,
        limit,
        order: searchParams.get('order'),
        archived,
      })
      const listed = [...chats.values()]
        .filter((chat) => (chat.archived ?? false) === archived)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return respondJson({
        items: listed.slice(offset, offset + limit).map(listedChat),
        total: listed.length,
        limit,
        offset,
        has_missing_conversations: false,
      })
    }

    throw new Error(`fake ChatGPT has no route for ${url}`)
  }

  return {
    fetch,
    /** Every conversations list request since the last clear, in order. */
    listRequests: () => [...listRequests],
    /** The ID of every chat read since the last clear, in order. */
    reads: () => [...reads],
    /** Forgets the requests so far, so a test sees only the next Sync's. */
    clearRequests: () => {
      listRequests = []
      reads = []
    },
    /** Adds a chat, or replaces the one with the same ID. */
    putChat: (chat: ChatFixture) => {
      chats.set(chat.id, chat)
    },
    /** Stores a session for this fake in the data directory, as install-chatgpt does. */
    storeSession: (dataDir: string) => {
      saveChatGPTSession(dataDir, { cookies: { [sessionCookie]: token } })
    },
    /** Sets a cookie with the next response and accepts only it from then on. */
    issueCookie: (name: string, value: string) => {
      unsent.push([name, value])
    },
    /** Removes a chat, as when Adwin deletes it. */
    removeChat: (id: string) => {
      chats.delete(id)
    },
    /** Answers the next read of the chat with `status`. */
    failRead: (id: string, status: number) => {
      failedReads.set(id, status)
    },
    /** Ends the session, as ChatGPT does when it signs the token out. */
    signOut: () => {
      signedIn = false
    },
    /** Answers the session exchange with `status`, as when ChatGPT is down. */
    failSession: (status: number) => {
      sessionStatus = status
    },
    /**
     * Answers requests under `path` with a Cloudflare challenge page, marked
     * by its `cf-mitigated` header unless `header` is false.
     */
    challenge: (path = '/', { header = true } = {}) => {
      challenged = { path, header }
    },
  }
}

export type FakeChatGPT = ReturnType<typeof createFakeChatGPT>
