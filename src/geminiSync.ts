import type { Archive, ArchivedThread } from '~/archive'
import type { Fetch, ListedChat, Turn } from '~/gemini'
import { extractSearchText } from '~/extract'
import { connectGemini, geminiLabel } from '~/gemini'

const toItem = (turn: Turn, type: string, payload: object) => {
  const at = turn.at.toISOString()
  const json = JSON.stringify(payload)
  return {
    // Stable across re-reads, so a re-read chat updates its rows.
    id: `${turn.responseId}:${type}`,
    type,
    status: 'completed',
    createdAt: at,
    completedAt: at,
    updatedAt: at,
    payload: json,
    searchText: extractSearchText(type, json),
  }
}

const markdownImage = ({ filename, url }: { filename: string; url: string }) =>
  `![${filename}](${url})`

/** The prompt, then its uploaded images, like T3's `t3-context://` references. */
const promptText = ({ prompt, uploads }: Turn) =>
  [prompt, uploads.map(markdownImage).join('\n')]
    .filter((part) => part !== '')
    .join('\n\n')

/** The reply with each generated image in place of its placeholder URL. */
const replyText = ({ reply, generated }: Turn) =>
  generated.reduce(
    (text, image) => text.replaceAll(image.placeholder, markdownImage(image)),
    reply,
  )

const toItems = (turn: Turn) => [
  toItem(turn, 'user_message', { text: promptText(turn) }),
  ...(turn.reasoning === ''
    ? []
    : [toItem(turn, 'reasoning', { text: turn.reasoning })]),
  ...(turn.reply === ''
    ? []
    : [toItem(turn, 'assistant_message', { text: replyText(turn) })]),
  ...(turn.sources.length === 0
    ? []
    : [toItem(turn, 'web_sources', { sources: turn.sources })]),
]

const toArchivedThread = (chat: ListedChat, turns: Turn[]): ArchivedThread => {
  const items = turns
    .flatMap(toItems)
    .map((item, ordinal) => ({ ...item, ordinal }))
  const updatedAt = chat.updatedAt.toISOString()
  return {
    id: chat.threadId,
    title: chat.title,
    projectTitle: null,
    workspaceRoot: null,
    createdAt: turns[0]?.at.toISOString() ?? updatedAt,
    updatedAt,
    archivedAt: null,
    // Gemini reports no Item count, so only the time is compared.
    signature: { updatedAt, itemCount: items.length, deleted: false },
    items,
  }
}

// Reading more per Sync risks Google throttling or flagging the account. A
// larger backlog drains over several Syncs.
const readCap = 60

/**
 * Archives the chats Gemini lists whose last update changed since they were
 * last read, oldest first and at most `readCap` per Sync. Chats missing from
 * the list are kept.
 */
export const syncGemini = async (
  archive: Archive,
  collaborators: {
    dataDir: string
    fetch: Fetch
    clock: () => Date
    pace: number
  },
) => {
  const gemini = await connectGemini(collaborators)
  archive.recordHost(geminiLabel, null)
  const stored = archive.signatures(geminiLabel)
  const isChanged = ({ threadId, updatedAt }: ListedChat) =>
    stored.get(threadId)?.updatedAt !== updatedAt.toISOString()

  // The list runs newest first, so paging stops at the first page without a
  // changed chat. Reading oldest first keeps that stop correct mid-backlog:
  // every changed chat left unread is newer than every one read.
  const changed: ListedChat[] = []
  let pageToken: string | undefined
  do {
    const page = await gemini.listChats(pageToken)
    const pageChanged = page.chats.filter(isChanged)
    if (pageChanged.length === 0) break
    changed.push(...pageChanged)
    pageToken = page.nextPageToken
  } while (pageToken !== undefined)

  const toRead = changed
    .toSorted((a, b) => +a.updatedAt - +b.updatedAt)
    .slice(0, readCap)
  // Each chat commits with its Signature, so an interrupted Sync re-reads
  // only what didn't land.
  for (const chat of toRead) {
    const turns = await gemini.readChat(chat.threadId)
    archive.saveThreads(geminiLabel, [toArchivedThread(chat, turns)])
  }
}
