import type { Fetch } from '~/web'
import { saveChatGPTSession, sessionCookie } from '~/chatgpt'

const token = 'fake-session-token'
const accessToken = 'fake-access-token'

export type ChatFixture = {
  id: string
  title: string
  /** ISO time of the chat's last update, as the list reports it. */
  updatedAt: string
  archived?: boolean
  /** The custom GPT the chat is with. */
  gizmoId?: string
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
  updatedAt,
  archived,
  gizmoId,
}: ChatFixture) => ({
  id,
  title,
  create_time: updatedAt,
  update_time: updatedAt,
  mapping: null,
  current_node: null,
  conversation_template_id: null,
  gizmo_id: gizmoId ?? null,
  is_archived: archived ?? false,
  workspace_id: null,
})

/**
 * A `fetch` that answers like chatgpt.com, from fixtures. Any other request
 * fails, so tests never reach chatgpt.com.
 */
export const createFakeChatGPT = () => {
  // The cookies chatgpt.com accepts: the latest it set for each name.
  const accepted = new Map([[sessionCookie, token]])
  const chats = new Map<string, ChatFixture>()
  const listRequests: ListRequest[] = []
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

    if (pathname === '/backend-api/conversations') {
      const headers = new Headers(init.headers)
      if (
        !authorized ||
        headers.get('Authorization') !== `Bearer ${accessToken}`
      ) {
        return respond(null, { status: 401 })
      }
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
    /** Every conversations list request, in order. */
    listRequests,
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
