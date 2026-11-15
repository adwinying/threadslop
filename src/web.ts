import { renameSync, rmSync, writeFileSync } from 'node:fs'

// Reaching a web app as Adwin, the way Gemini and ChatGPT are Synced: requests
// carrying his session cookies, and the session store that keeps them.

/** The subset of `fetch` the web apps need; tests inject fakes. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Writes a session store atomically, readable by its owner only. */
export const saveSessionStore = (file: string, session: object) => {
  const temporary = `${file}.tmp`
  // A file left by an interrupted save would keep its mode.
  rmSync(temporary, { force: true })
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 })
  renameSync(temporary, file)
}

const userAgent =
  'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'

export type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>
}

/**
 * Sends requests with the jar's cookies, `pace` milliseconds apart, updating
 * the jar with the cookies the web app sets and calling `onSetCookies` when it
 * did.
 */
export const createRequest = ({
  jar,
  fetch,
  onSetCookies = () => undefined,
  pace = 0,
}: {
  jar: Map<string, string>
  fetch: Fetch
  onSetCookies?: () => void
  pace?: number
}) => {
  let sentAny = false
  return async (url: string, init: RequestOptions = {}) => {
    if (sentAny) await Bun.sleep(pace)
    sentAny = true
    const response = await fetch(url, {
      ...init,
      // A signed-out redirect is judged by the caller, not followed.
      redirect: 'manual',
      headers: {
        'User-Agent': userAgent,
        Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...init.headers,
      },
    })
    const setCookies = response.headers.getSetCookie()
    for (const header of setCookies) {
      const [pair = ''] = header.split(';')
      const index = pair.indexOf('=')
      jar.set(pair.slice(0, index), pair.slice(index + 1))
    }
    if (setCookies.length > 0) onSetCookies()
    return response
  }
}
