import type { Fetch } from '~/web'
import { saveChatGPTSession } from '~/chatgpt'

const sessionCookie = '__Secure-next-auth.session-token'
const token = 'fake-session-token'
const accessToken = 'fake-access-token'

/**
 * A `fetch` that answers like chatgpt.com, from fixtures. Any other request
 * fails, so tests never reach OpenAI.
 */
export const createFakeChatGPT = () => {
  // The cookies chatgpt.com accepts: the latest it set for each name.
  const accepted = new Map([[sessionCookie, token]])
  let unsent: [name: string, value: string][] = []
  let signedIn = true
  let challenging = false
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
    const { origin, pathname } = new URL(url)
    if (origin !== 'https://chatgpt.com') {
      throw new Error(`fake ChatGPT has no route for ${url}`)
    }
    if (challenging) {
      // What Cloudflare sends a client it won't let through.
      return respond('<!DOCTYPE html><title>Just a moment...</title>', {
        status: 403,
        headers: { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' },
      })
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

    throw new Error(`fake ChatGPT has no route for ${url}`)
  }

  return {
    fetch,
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
    /** Answers every request with a Cloudflare challenge. */
    challenge: () => {
      challenging = true
    },
  }
}

export type FakeChatGPT = ReturnType<typeof createFakeChatGPT>
