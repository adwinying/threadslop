import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// Everything about Google's undocumented wire format lives in this module. The
// positions were observed in the web app's traffic, not documented, so parsing
// is defensive: a shape that doesn't match fails the read instead of saving
// half a chat.

/** The Source label Gemini Threads are archived under. */
export const geminiLabel = 'gemini'

/** The web URL of a Gemini chat, by Thread ID. */
export const geminiChatUrl = (threadId: string) =>
  `https://gemini.google.com/app/${threadId}`

/** The subset of `fetch` Gemini needs; tests inject a fake Gemini. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const sessionSchema = z.object({
  cookies: z.record(z.string(), z.string()),
})

export type GeminiSession = z.infer<typeof sessionSchema>

const sessionFile = (dataDir: string) => join(dataDir, 'gemini-session.json')

/** Gemini is a Source only while its session store exists. */
export const hasGeminiSession = (dataDir: string) =>
  existsSync(sessionFile(dataDir))

/** Writes the session store atomically, readable by its owner only. */
export const saveGeminiSession = (dataDir: string, session: GeminiSession) => {
  const file = sessionFile(dataDir)
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 })
  renameSync(temporary, file)
}

const loadSession = (dataDir: string) =>
  sessionSchema.parse(JSON.parse(readFileSync(sessionFile(dataDir), 'utf8')))

/** A chat as the listing reports it. */
export type ListedChat = { threadId: string; title: string; updatedAt: Date }

/** One prompt and Gemini's reply to it. */
export type Turn = {
  responseId: string
  prompt: string
  /** Markdown; `''` when Gemini never answered. */
  reply: string
  at: Date
}

const userAgent =
  'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'
const appUrl = 'https://gemini.google.com/app'
const batchUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute'
const pageOrigin = {
  Origin: 'https://gemini.google.com',
  Referer: 'https://gemini.google.com/',
}

const rpcs = { listChats: 'MaZiqc', readChat: 'hNvQHb' }

const chatsPerPage = 100
// No chat in the spike's crawl had more turns. A longer one fails its read
// rather than being saved truncated.
const turnLimit = 200

/** The value at a path of array indexes, or undefined where one is missing. */
const pick = (value: unknown, ...path: number[]) =>
  path.reduce<unknown>(
    (node, index) => (Array.isArray(node) ? node[index] : undefined),
    value,
  )

/** `[seconds, nanos]` */
const timestampSchema = z
  .tuple([z.number(), z.number()])
  .transform(
    ([seconds, nanos]) => new Date(seconds * 1000 + Math.floor(nanos / 1e6)),
  )

const listedChatSchema = z.object({
  chatId: z.string().startsWith('c_'),
  title: z.string(),
  updatedAt: timestampSchema,
})

const parseListedChat = (chat: unknown): ListedChat => {
  const { chatId, title, updatedAt } = listedChatSchema.parse({
    chatId: pick(chat, 0),
    title: pick(chat, 1),
    updatedAt: pick(chat, 5),
  })
  return { threadId: chatId.slice('c_'.length), title, updatedAt }
}

const parseListPage = (body: unknown) => {
  // An account without chats lists none.
  const chats = z.array(z.unknown()).nullish().parse(pick(body, 2)) ?? []
  return {
    chats: chats.map(parseListedChat),
    nextPageToken: z.string().nullish().parse(pick(body, 1)) ?? undefined,
  }
}

const turnSchema = z.object({
  responseId: z.string().min(1),
  prompt: z.string(),
  reply: z
    .string()
    .nullish()
    .transform((reply) => reply ?? ''),
  at: timestampSchema,
})

const parseTurn = (turn: unknown): Turn => {
  const candidate = pick(turn, 3, 0, 0)
  return turnSchema.parse({
    // `turn[0][0]` is the chat ID. The response ID's position next to it is a
    // guess from the spike's traffic; fix it here if Google proves it wrong.
    responseId: pick(turn, 0, 1),
    prompt: pick(turn, 2, 0, 0),
    reply: pick(candidate, 1, 0),
    at: pick(turn, 4),
  })
}

const parseTurns = (body: unknown) =>
  z
    .array(z.unknown())
    .parse(pick(body, 0))
    .map(parseTurn)
    // The order turns arrive in isn't established, so sort them by time.
    .toSorted((a, b) => +a.at - +b.at)

/** Runs a parser, naming what didn't parse when Google's format changed. */
const parseOrThrow = <T>(what: string, parse: () => T) => {
  try {
    return parse()
  } catch (cause) {
    if (!(cause instanceof z.ZodError)) throw cause
    throw new Error(`${what} didn't parse: ${z.prettifyError(cause)}`, {
      cause,
    })
  }
}

/** Parses a line of JSON, or gives undefined when it isn't JSON. */
const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** Finds the rpc's result in a batchexecute response; none means throttled. */
const resultOf = (text: string, rpc: string): unknown => {
  // With `rt=c` each line of frames follows a line holding its length.
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('['))
    .flatMap((line) => z.array(z.unknown()).catch([]).parse(parseLine(line)))
  const result = frames.find(
    (frame) => pick(frame, 0) === 'wrb.fr' && pick(frame, 1) === rpc,
  )
  const body = pick(result, 2)
  // Never read as an empty answer: that would wipe archived Items.
  if (typeof body !== 'string') {
    throw new Error(`Gemini answered ${rpc} without a result; throttled?`)
  }
  return JSON.parse(body)
}

const tokenIn = (page: string, key: string) =>
  page.match(new RegExp(`"${key}":\\s*"(.*?)"`))?.[1]

/**
 * Signs in to Gemini with the stored session. Throws when the session no
 * longer signs in.
 */
export const connectGemini = async ({
  dataDir,
  fetch,
}: {
  dataDir: string
  fetch: Fetch
}) => {
  const jar = new Map(Object.entries(loadSession(dataDir).cookies))

  const request = async (
    url: string,
    init: Omit<RequestInit, 'headers'> & {
      headers?: Record<string, string>
    } = {},
  ) => {
    const response = await fetch(url, {
      ...init,
      // A signed-out redirect is judged by the missing token, not followed.
      redirect: 'manual',
      headers: {
        'User-Agent': userAgent,
        Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...init.headers,
      },
    })
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';')
      const index = pair.indexOf('=')
      jar.set(pair.slice(0, index), pair.slice(index + 1))
    }
    return response
  }

  const page = await (await request(appUrl, { headers: pageOrigin })).text()
  const at = tokenIn(page, 'SNlM0e')
  if (at === undefined) throw new Error('signed out; run install-gemini')
  const bl = tokenIn(page, 'cfb2h')
  const fsid = tokenIn(page, 'FdrFJe')
  const hl = tokenIn(page, 'TuX5cc') ?? 'en'

  const browserSessionId = crypto.randomUUID().toUpperCase()
  let requestId = 100000 + Math.floor(Math.random() * 9000)

  const call = async (rpc: string, payload: unknown) => {
    requestId += 100000
    const query = new URLSearchParams({
      rpcids: rpc,
      hl,
      _reqid: String(requestId),
      rt: 'c',
      'source-path': '/app',
      ...(bl && { bl }),
      ...(fsid && { 'f.sid': fsid }),
    })
    const response = await request(`${batchUrl}?${query}`, {
      method: 'POST',
      headers: {
        ...pageOrigin,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'X-Same-Domain': '1',
        'x-goog-ext-525001261-jspb': JSON.stringify([
          1,
          ...Array.from({ length: 7 }, () => null),
          [4, 5, 6, 8],
          ...Array.from({ length: 7 }, () => null),
          browserSessionId,
        ]),
        'x-goog-ext-73010989-jspb': '[0]',
      },
      body: new URLSearchParams({
        at,
        'f.req': JSON.stringify([
          [[rpc, JSON.stringify(payload), null, 'generic']],
        ]),
      }),
    })
    if (!response.ok) {
      throw new Error(`Gemini answered ${rpc} with HTTP ${response.status}`)
    }
    return resultOf(await response.text(), rpc)
  }

  return {
    /** One page of chats, most recently updated first. */
    listChats: async (pageToken?: string) => {
      const body = await call(rpcs.listChats, [
        chatsPerPage,
        pageToken ?? null,
        [0, null, 1],
      ])
      return parseOrThrow('Gemini chat list', () => parseListPage(body))
    },

    /** A chat's turns, oldest first. */
    readChat: async (threadId: string) => {
      const body = await call(rpcs.readChat, [
        `c_${threadId}`,
        turnLimit,
        null,
        1,
        [1],
        [4],
        null,
        1,
      ])
      // A marker of more turns means the read is truncated.
      if (pick(body, 1) != null) {
        throw new Error(`Gemini chat ${threadId} has over ${turnLimit} turns`)
      }
      return parseOrThrow(`Gemini chat ${threadId}`, () => parseTurns(body))
    },
  }
}

export type GeminiClient = Awaited<ReturnType<typeof connectGemini>>
