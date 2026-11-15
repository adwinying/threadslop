import type { Fetch } from '~/gemini'
import { z } from 'zod'
import { saveGeminiSession } from '~/gemini'

type ImageFixture = { filename: string; url: string }

export type TurnFixture = {
  /** The response ID Gemini gives the turn, e.g. `r_…`. */
  responseId: string
  prompt: string
  /**
   * Images uploaded with the prompt. Gemini puts each in its upload entry at
   * index 3 or 4, as `slot` picks; 3 when absent.
   */
  uploads?: (ImageFixture & { slot?: 3 | 4 })[]
  /** Markdown; `''` for a turn Gemini never answered. */
  reply: string
  /** Images Gemini generated, each shown in the reply by its placeholder URL. */
  generated?: (ImageFixture & { placeholder: string })[]
  reasoning?: string
  /** The web sources the reply cites. */
  sources?: { url: string; title?: string }[]
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
  /** Sets the read's "more turns" marker, as for a chat over the turn limit. */
  truncated?: boolean
  /** Google can't load it, so it refuses every list page holding it. */
  broken?: boolean
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
const listPayloadSchema = z.tuple(
  [z.number(), z.string().nullable()],
  z.unknown(),
)

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

/** An array holding `entries` at their indexes and null elsewhere. */
const sparse = (entries: Record<number, unknown>) => {
  const array: unknown[] = Array.from(
    { length: Math.max(...Object.keys(entries).map(Number)) + 1 },
    () => null,
  )
  for (const [index, value] of Object.entries(entries)) {
    array[Number(index)] = value
  }
  return array
}

const wireCandidate = (turn: TurnFixture) =>
  sparse({
    0: `rc_${turn.responseId}`,
    1: [turn.reply],
    ...(turn.sources && {
      2: [
        null,
        turn.sources.map(({ url, title }) => [
          null,
          null,
          [[url, title ?? null]],
        ]),
      ],
    }),
    ...(turn.generated && {
      12: sparse({
        7: [
          turn.generated.map(({ placeholder, filename, url }) => [
            [null, null, null, [null, 1, filename, url]],
            [placeholder],
          ]),
        ],
      }),
    }),
    ...(turn.reasoning !== undefined && { 37: [[turn.reasoning]] }),
  })

const wireTurn = (chatId: string, turn: TurnFixture) => [
  [`c_${chatId}`, turn.responseId],
  null,
  [
    [
      turn.prompt,
      null,
      null,
      null,
      turn.uploads?.map(({ filename, url, slot = 3 }) => {
        const entry: unknown[] = [null, null, null, null]
        entry[slot] = [[null, 1, filename, url]]
        return entry
      }) ?? null,
    ],
  ],
  [[wireCandidate(turn)]],
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

// What Google sends for a list page holding a chat it can't load.
const refusalFrame = (rpc: string) => [
  'wrb.fr',
  rpc,
  null,
  null,
  null,
  [
    13,
    null,
    [
      [
        'type.googleapis.com/assistant.boq.bard.application.BardErrorInfo',
        [1096, null, "Couldn't load conversation. Try again. (1096)"],
      ],
    ],
  ],
  'generic',
]

// Frames every response carries. Alone, they're what Google sends while it
// throttles.
const routineFrames = [
  ['di', 12],
  ['af.httprm', 11, '-4011571396556183958', 4],
  ['e', 4, null, null, 139],
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
  let appPageStatus: number | undefined
  let answersBeforeThrottle = Infinity
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
      const [perPage, pageToken] = listPayloadSchema.parse(payload)
      const start = pageToken === null ? 0 : Number(pageToken)
      const listed = [...chats.values()]
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(start, start + perPage)
      if (listed.some((chat) => chat.broken)) {
        return [refusalFrame(rpc), ...routineFrames]
      }
      const next = start + perPage
      return [
        resultFrame(rpc, [
          null,
          next < chats.size ? String(next) : null,
          listed.map(listedChat),
        ]),
      ]
    }
    if (rpc === 'hNvQHb') {
      const id = chatIdOf(payload)
      const chat = chats.get(id)
      if (!chat) throw new Error(`fake Gemini has no chat ${id}`)
      // Newest first, so the client must order turns itself.
      return [
        resultFrame(rpc, [
          chat.turns.map((turn) => wireTurn(id, turn)).toReversed(),
          chat.truncated ? 'fake-more-turns-token' : null,
        ]),
      ]
    }
    throw new Error(`fake Gemini has no rpc ${rpc}`)
  }

  const fetch: Fetch = async (url, init) => {
    const { origin, pathname, searchParams } = new URL(url)
    const cookieHeader = new Headers(init.headers).get('Cookie') ?? ''
    const authorized = signedIn && hasSessionCookies(cookieHeader)

    if (origin === 'https://gemini.google.com' && pathname === '/app') {
      if (appPageStatus !== undefined) {
        return respond(null, { status: appPageStatus })
      }
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
          answersBeforeThrottle-- <= 0 ? routineFrames : answer(rpc, parsed),
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
    /** Answers the app page with `status`, as Google does when down or busy. */
    failAppPage: (status: number) => {
      appPageStatus = status
    },
    /**
     * Answers every rpc after the next `answered` without a result frame, as
     * Google does when it throttles.
     */
    throttle: (answered = 0) => {
      answersBeforeThrottle = answered
    },
  }
}

export type FakeGemini = ReturnType<typeof createFakeGemini>
