import type { Fetch } from '~/gemini'
import { z } from 'zod'
import { saveGeminiSession } from '~/gemini'

export type TurnFixture = {
  /** The response ID Gemini gives the turn, e.g. `r_…`. */
  responseId: string
  prompt: string
  /** Markdown; `''` for a turn Gemini never answered. */
  reply: string
  /** ISO time of the turn. */
  at: string
}

export type ChatFixture = {
  /** The Thread ID, without the `c_` prefix Gemini's wire format adds. */
  id: string
  title: string
  /** ISO time of the chat's last update, as the listing reports it. */
  updatedAt: string
  /** Oldest first. */
  turns: TurnFixture[]
}

const cookies = {
  '__Secure-1PSID': 'fake-psid',
  '__Secure-1PSIDTS': 'fake-psidts',
}
const accessToken = 'fake-at-token'
const rotateBody = '[000,"-0000000000000000000"]'

/** batchexecute's `f.req`: the rpc with its payload, JSON-encoded again. */
const requestSchema = z.tuple([
  z.tuple([z.tuple([z.string(), z.string()], z.unknown())]),
])
const readPayloadSchema = z.tuple([z.string().startsWith('c_')], z.unknown())

/** Gemini's `[seconds, nanos]` timestamp. */
const toTimestamp = (iso: string) => {
  const ms = Date.parse(iso)
  return [Math.floor(ms / 1000), (ms % 1000) * 1e6]
}

const listedChat = ({ id, title, updatedAt }: ChatFixture) => [
  `c_${id}`,
  title,
  null,
  null,
  null,
  toTimestamp(updatedAt),
]

const wireTurn = (chatId: string, turn: TurnFixture) => [
  [`c_${chatId}`, turn.responseId],
  null,
  [[turn.prompt]],
  [[[`rc_${turn.responseId}`, [turn.reply]]]],
  toTimestamp(turn.at),
]

/** A batchexecute response body in the chunked (`rt=c`) format. */
const chunked = (frames: unknown[][]) => {
  const line = JSON.stringify(frames)
  return `)]}'\n\n${line.length}\n${line}\n`
}

const resultFrame = (rpc: string, body: unknown) => [
  'wrb.fr',
  rpc,
  JSON.stringify(body),
  null,
  null,
  null,
  'generic',
]

// What Google sends instead of a result while it throttles.
const throttledFrames = [
  ['di', 12],
  ['af.httprm', 11, '-4011571396556183958', 4],
]

const signedInPage = `<script>window.WIZ_global_data = {"SNlM0e":"${accessToken}","cfb2h":"boq_assistant-bard-web-server_20261110.08_p0","FdrFJe":"-4011571396556183958","TuX5cc":"en"};</script>`

/** The Thread ID a read asks for. */
const chatIdOf = (payload: unknown) =>
  readPayloadSchema.parse(payload)[0].slice('c_'.length)

export type GeminiRequest = { rpc: string; payload: unknown }

/**
 * A `fetch` that answers like gemini.google.com in the real wire format, from
 * chat fixtures. Any other request fails, so tests never reach Google.
 */
export const createFakeGemini = () => {
  const chats = new Map<string, ChatFixture>()
  const requests: GeminiRequest[] = []
  // The cookies Google accepts: the latest it set for each name.
  const accepted = new Map(Object.entries(cookies))
  let unsent: [name: string, value: string][] = []
  let rotations = 0
  let signedIn = true
  let throttled = false
  let refusingRotations = false

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
        `${name}=${value}; Domain=.google.com; Path=/; Expires=Mon, 15-Nov-2027 00:00:00 GMT; Secure; HttpOnly; SameSite=none`,
      )
    }
    unsent = []
    return new Response(body, { ...init, headers })
  }

  const answer = (rpc: string, payload: unknown) => {
    if (rpc === 'MaZiqc') {
      const listed = [...chats.values()].toSorted((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      )
      return [null, null, listed.map(listedChat)]
    }
    if (rpc === 'hNvQHb') {
      const id = chatIdOf(payload)
      const chat = chats.get(id)
      if (!chat) throw new Error(`fake Gemini has no chat ${id}`)
      // Newest first, so the client must order turns itself.
      return [chat.turns.map((turn) => wireTurn(id, turn)).toReversed(), null]
    }
    throw new Error(`fake Gemini has no rpc ${rpc}`)
  }

  const fetch: Fetch = async (url, init) => {
    const { origin, pathname, searchParams } = new URL(url)
    const cookieHeader = new Headers(init.headers).get('Cookie') ?? ''
    const authorized = signedIn && hasSessionCookies(cookieHeader)

    if (origin === 'https://gemini.google.com' && pathname === '/app') {
      return authorized
        ? respond(signedInPage)
        : respond(null, {
            status: 302,
            headers: { Location: 'https://accounts.google.com/ServiceLogin' },
          })
    }

    if (
      origin === 'https://accounts.google.com' &&
      pathname === '/RotateCookies'
    ) {
      if (init.method !== 'POST' || init.body !== rotateBody) {
        return respond(null, { status: 400 })
      }
      if (!authorized) return respond(null, { status: 401 })
      if (refusingRotations) return respond(null, { status: 429 })
      rotations += 1
      unsent.push(['__Secure-1PSIDTS', `fake-psidts-rotated-${rotations}`])
      return respond(null)
    }

    if (
      origin === 'https://gemini.google.com' &&
      pathname === '/_/BardChatUi/data/batchexecute'
    ) {
      const form = new URLSearchParams(await new Response(init.body).text())
      if (!authorized || form.get('at') !== accessToken) {
        return respond(null, { status: 401 })
      }
      const [[[rpc, payload]]] = requestSchema.parse(
        JSON.parse(form.get('f.req') ?? ''),
      )
      if (rpc !== searchParams.get('rpcids')) {
        return respond(null, { status: 400 })
      }
      const parsed: unknown = JSON.parse(payload)
      requests.push({ rpc, payload: parsed })
      return respond(
        chunked(
          throttled ? throttledFrames : [resultFrame(rpc, answer(rpc, parsed))],
        ),
      )
    }

    throw new Error(`fake Gemini has no route for ${url}`)
  }

  return {
    fetch,
    /** Every batchexecute call, in order. */
    requests,
    /** IDs of the chats read, in order. */
    reads: () =>
      requests
        .filter(({ rpc }) => rpc === 'hNvQHb')
        .map(({ payload }) => chatIdOf(payload)),
    /**
     * Stores a session for this fake in the data directory, as install-gemini
     * does, or as a Sync left it after rotating at `rotatedAt`.
     */
    storeSession: (
      dataDir: string,
      { rotatedAt }: { rotatedAt?: Date } = {},
    ) => {
      saveGeminiSession(dataDir, { cookies, rotatedAt })
    },
    /** How many times the cookies were rotated. */
    rotations: () => rotations,
    /** Sets a cookie with the next response and accepts only it from then on. */
    issueCookie: (name: string, value: string) => {
      unsent.push([name, value])
    },
    /** Answers every rotation with 429, as Google does to rotations minutes apart. */
    refuseRotations: () => {
      refusingRotations = true
    },
    /** Adds a chat, or replaces the one with the same ID. */
    putChat: (chat: ChatFixture) => {
      chats.set(chat.id, chat)
    },
    removeChat: (id: string) => {
      chats.delete(id)
    },
    /** Ends the session, as Google does when it signs the cookies out. */
    signOut: () => {
      signedIn = false
    },
    /** Answers every rpc without a result frame, as Google does when it throttles. */
    throttle: () => {
      throttled = true
    },
  }
}

export type FakeGemini = ReturnType<typeof createFakeGemini>
