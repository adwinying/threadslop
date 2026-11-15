import type { Fetch } from '~/web'
import { existsSync } from 'node:fs'
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

const origin = 'https://chatgpt.com'

/** Fails a response that isn't OK, naming Cloudflare when it challenged. */
const ensureOk = (response: Response, path: string) => {
  if (response.ok) return
  if (response.headers.get('cf-mitigated') === 'challenge') {
    throw new Error(`Cloudflare challenged ${path}`)
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
  ensureOk(response, path)
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
