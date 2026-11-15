import type { Fetch } from '~/web'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createRequest, saveSessionStore } from '~/web'

// Everything about Google's undocumented wire format lives in this module. The
// positions were observed in the web app's traffic, not documented, so parsing
// is defensive: a shape that doesn't match fails the read instead of saving
// half a chat.

/** The Source label Gemini Threads are archived under. */
export const geminiLabel = 'gemini'

/** The web URL of a Gemini chat, by Thread ID. */
export const geminiChatUrl = (threadId: string) =>
  `https://gemini.google.com/app/${threadId}`

const sessionSchema = z.object({
  cookies: z.record(z.string(), z.string()),
  /** Absent until the first rotation. */
  rotatedAt: z.coerce.date().optional(),
})

export type GeminiSession = z.infer<typeof sessionSchema>

const sessionFile = (dataDir: string) => join(dataDir, 'gemini-session.json')

/** Gemini is a Source only while its session store exists. */
export const hasGeminiSession = (dataDir: string) =>
  existsSync(sessionFile(dataDir))

export const saveGeminiSession = (dataDir: string, session: GeminiSession) => {
  saveSessionStore(sessionFile(dataDir), session)
}

const loadSession = (dataDir: string) =>
  sessionSchema.parse(JSON.parse(readFileSync(sessionFile(dataDir), 'utf8')))

/** A chat as the listing reports it. */
export type ListedChat = { threadId: string; title: string; updatedAt: Date }

const appUrl = 'https://gemini.google.com/app'
const rotateUrl = 'https://accounts.google.com/RotateCookies'
const rotationInterval = 10 * 60 * 1000
const batchUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute'
const pageOrigin = {
  Origin: 'https://gemini.google.com',
  Referer: 'https://gemini.google.com/',
}

const rpcs = { listChats: 'MaZiqc', readChat: 'hNvQHb' }

const chatsPerPage = 100
// More than any chat in the spike's crawl had, so most chats take one read.
const turnsPerPage = 200

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

const optionalText = z
  .string()
  .nullish()
  .transform((text) => text ?? '')

/** The list at a path; absent means empty. */
const listAt = (value: unknown, ...path: number[]) =>
  z
    .array(z.unknown())
    .nullish()
    .parse(pick(value, ...path)) ?? []

const imageSchema = z.object({ filename: z.string(), url: z.string() })

const turnSchema = z.object({
  responseId: z.string().min(1),
  prompt: z.string(),
  uploads: z.array(imageSchema),
  /** Markdown; `''` when Gemini never answered. */
  reply: optionalText,
  /** Images Gemini generated, each shown in the reply by its placeholder URL. */
  generated: z.array(imageSchema.extend({ placeholder: z.string() })),
  /** `''` when the turn has none. */
  reasoning: optionalText,
  /** The web sources the reply cites. */
  sources: z.array(
    z.object({
      url: z.string(),
      // The title's position is a guess; a wrong guess drops the title only.
      title: z.string().optional().catch(undefined),
    }),
  ),
  at: timestampSchema,
})

/** One prompt and Gemini's reply to it. */
export type Turn = z.infer<typeof turnSchema>

// The positions of everything but the chat ID, prompt, reply, reasoning and
// time are guesses from the spike's traffic. Each is read here only, so a
// position Google proves wrong is a one-line fix.
const parseTurn = (turn: unknown) => {
  const prompt = pick(turn, 2, 0)
  const candidate = pick(turn, 3, 0, 0)
  return turnSchema.parse({
    // `turn[0][0]` is the chat ID.
    responseId: pick(turn, 0, 1),
    prompt: pick(prompt, 0),
    uploads: listAt(prompt, 4)
      // Gemini sends an empty entry for an upload it kept no image of.
      .filter((upload) => !(Array.isArray(upload) && upload.length === 0))
      .map((upload) => {
        // Gemini puts the image at index 3, 4 or both.
        const image = pick(upload, 3, 0) ?? pick(upload, 4, 0)
        return { filename: pick(image, 2), url: pick(image, 3) }
      }),
    reply: pick(candidate, 1, 0),
    generated: listAt(candidate, 12, 7, 0).map((image) => ({
      filename: pick(image, 0, 3, 2),
      url: pick(image, 0, 3, 3),
      placeholder: pick(image, 1, 0),
    })),
    reasoning: pick(candidate, 37, 0, 0),
    sources: listAt(candidate, 2, 1).map((source) => ({
      url: pick(source, 2, 0, 0),
      title: pick(source, 2, 0, 1),
    })),
    at: pick(turn, 4),
  })
}

const parseTurnPage = (body: unknown) => ({
  turns: z.array(z.unknown()).parse(pick(body, 0)).map(parseTurn),
  nextPageToken: z.string().nullish().parse(pick(body, 1)) ?? undefined,
})

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

/** Finds the rpc's result in a batchexecute response. */
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
  if (typeof body === 'string') return JSON.parse(body)
  // Never read as an empty answer: that would wipe archived Items. Every
  // response carries `di`, `af.httprm` and `e` frames; any other frame, or a
  // response without frames, says what failed. Evidence is cut short, as
  // /health shows it to anyone on the LAN.
  const routine = ['di', 'af.httprm', 'e']
  const evidence =
    frames.length === 0
      ? [text]
      : frames
          .filter((frame) => !routine.includes(String(pick(frame, 0))))
          .map((frame) => JSON.stringify(frame))
  const detail =
    evidence.length > 0
      ? `: ${evidence.map((item) => item.slice(0, 200)).join(' ')}`
      : '; throttled?'
  const message = `Gemini answered ${rpc} without a result${detail}`
  // BardErrorInfo 1096: "Couldn't load conversation".
  const unloadable = pick(result, 5, 2, 0, 1, 0) === 1096
  throw unloadable ? new UnloadableChatError(message) : new Error(message)
}

/** Google refused the rpc because a chat it touches can't be loaded. */
class UnloadableChatError extends Error {}

const tokenIn = (page: string, key: string) =>
  page.match(new RegExp(`"${key}":\\s*"(.*?)"`))?.[1]

/**
 * Loads the web app for its session tokens. Resolves with undefined when
 * signed out: Google redirects to sign-in or serves a page without the tokens.
 * Throws on any other failure, which signing in again wouldn't fix.
 */
const signIn = async (request: ReturnType<typeof createRequest>) => {
  const response = await request(appUrl, { headers: pageOrigin })
  if (response.status >= 300 && response.status < 400) return undefined
  if (!response.ok) {
    throw new Error(`Gemini answered the app page with HTTP ${response.status}`)
  }
  const page = await response.text()
  // The XSRF token batchexecute requires as its `at` form field.
  const accessToken = tokenIn(page, 'SNlM0e')
  if (accessToken === undefined) return undefined
  return {
    accessToken,
    bl: tokenIn(page, 'cfb2h'),
    fsid: tokenIn(page, 'FdrFJe'),
    hl: tokenIn(page, 'TuX5cc') ?? 'en',
  }
}

/**
 * Runs the sign-in check on cookies not yet stored. Resolves with the cookies
 * to store, including any Google set meanwhile, or undefined when signed out.
 */
export const checkGeminiSignIn = async ({
  cookies,
  fetch,
}: {
  cookies: Record<string, string>
  fetch: Fetch
}) => {
  const jar = new Map(Object.entries(cookies))
  const signedIn = await signIn(createRequest({ jar, fetch }))
  return signedIn && Object.fromEntries(jar)
}

/** What reaching Gemini with the stored session takes. */
export type GeminiCollaborators = {
  dataDir: string
  fetch: Fetch
  clock: () => Date
  /** Milliseconds between requests, so Google doesn't throttle. */
  pace: number
}

/**
 * Signs in to Gemini with the stored session, rotating its cookies when the
 * last rotation is old enough. Throws when the session no longer signs in.
 */
export const connectGemini = async ({
  dataDir,
  fetch,
  clock,
  pace,
}: GeminiCollaborators) => {
  const session = loadSession(dataDir)
  const jar = new Map(Object.entries(session.cookies))
  let { rotatedAt } = session
  const save = () => {
    saveGeminiSession(dataDir, { cookies: Object.fromEntries(jar), rotatedAt })
  }
  // Saved at once: Google may already reject the cookies they replace.
  const request = createRequest({ jar, fetch, onSetCookies: save, pace })

  if (rotatedAt === undefined || +clock() - +rotatedAt >= rotationInterval) {
    const rotation = await request(rotateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://accounts.google.com',
      },
      body: '[000,"-0000000000000000000"]',
    })
    // A refusal isn't fatal: Google answers 429 to rotations minutes apart,
    // and the sign-in check below judges whether the session still works.
    if (rotation.ok) {
      rotatedAt = clock()
      save()
    }
  }

  const tokens = await signIn(request)
  if (tokens === undefined) throw new Error('signed out; run install-gemini')
  const { accessToken, bl, fsid, hl } = tokens

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
        at: accessToken,
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
      try {
        const body = await call(rpcs.listChats, [
          chatsPerPage,
          pageToken ?? null,
          [0, null, 1],
        ])
        return parseOrThrow('Gemini chat list', () => parseListPage(body))
      } catch (error) {
        // Google refuses every page from a chat it can't load onward, so such
        // a refusal of a later page ends the list. Anything else still fails.
        if (
          pageToken === undefined ||
          !(error instanceof UnloadableChatError)
        ) {
          throw error
        }
        console.warn(`${error.message}; the list ends at the page before`)
        return { chats: [], nextPageToken: undefined }
      }
    },

    /** A chat's turns, oldest first. */
    readChat: async (threadId: string) => {
      const turns: Turn[] = []
      let pageToken: string | undefined
      do {
        const body = await call(rpcs.readChat, [
          `c_${threadId}`,
          turnsPerPage,
          pageToken ?? null,
          1,
          [1],
          [4],
          null,
          1,
        ])
        const page = parseOrThrow(`Gemini chat ${threadId}`, () =>
          parseTurnPage(body),
        )
        // Guards against paging forever: Syncs never overlap, so one stuck
        // read would stall every Source.
        if (page.nextPageToken !== undefined && page.turns.length === 0) {
          throw new Error(`Gemini chat ${threadId} paged without turns`)
        }
        turns.push(...page.turns)
        pageToken = page.nextPageToken
      } while (pageToken !== undefined)
      // Pages run newest first, but the order within one isn't established.
      return turns.toSorted((a, b) => +a.at - +b.at)
    },
  }
}
