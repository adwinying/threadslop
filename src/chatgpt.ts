import type { Fetch } from '~/web'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createRequest, saveSessionStore } from '~/web'

// Everything about chatgpt.com's undocumented backend API lives in this
// module. Its shapes come from maintained exporters' source, not OpenAI.

/** The Source label ChatGPT Threads are archived under. */
export const chatgptLabel = 'chatgpt'

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

// Only the ID: the spike checks the list arrives, and what each chat holds is
// verified against real responses before the full slice parses it.
const listPageSchema = z.object({
  items: z.array(z.object({ id: z.string() })),
})

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

  return {
    /** One page of chats, most recently updated first. */
    listChats: async ({
      offset,
      archived,
    }: {
      offset: number
      archived: boolean
    }) => {
      const path = '/backend-api/conversations'
      const query = new URLSearchParams({
        offset: String(offset),
        limit: String(chatsPerPage),
        order: 'updated',
        is_archived: String(archived),
      })
      const response = await request(`${origin}${path}?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      await ensureOk(response, path)
      const page = listPageSchema.safeParse(await response.json())
      if (!page.success) {
        throw new Error(
          `ChatGPT's chat list didn't parse: ${z.prettifyError(page.error)}`,
        )
      }
      const { items } = page.data
      return {
        chats: items,
        // A short page is the last.
        nextOffset:
          items.length < chatsPerPage ? undefined : offset + items.length,
      }
    },
  }
}
