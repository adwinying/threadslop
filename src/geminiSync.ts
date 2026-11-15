import type { Archive, ArchivedThread } from '~/archive'
import type { GeminiCollaborators, ListedChat, Turn } from '~/gemini'
import { extractSearchText } from '~/extract'
import { connectGemini, geminiLabel } from '~/gemini'

const toItem = (
  threadId: string,
  turn: Turn,
  type: string,
  payload: object,
) => {
  const at = turn.at.toISOString()
  const json = JSON.stringify(payload)
  return {
    // Stable across re-reads, so a re-read Thread updates its rows. Item IDs
    // are unique per Source, and the response ID's position is a guess, so
    // the Thread ID keeps one Thread's Items from ever replacing another's.
    id: `${threadId}:${turn.responseId}:${type}`,
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

/**
 * The prompt, then its uploads, like T3's `t3-context://` references: an image
 * as a Markdown image, any other file by name.
 */
const promptText = ({ prompt, uploads }: Turn) =>
  [
    prompt,
    uploads
      .map(({ filename, url }) =>
        url === null ? filename : markdownImage({ filename, url }),
      )
      .join('\n'),
  ]
    .filter((part) => part !== '')
    .join('\n\n')

/** The reply with each generated image in place of its placeholder URL. */
const replyText = ({ reply, generated }: Turn) =>
  generated.reduce(
    (text, image) => text.replaceAll(image.placeholder, markdownImage(image)),
    reply,
  )

const toItems = (threadId: string, turn: Turn) => {
  const item = (type: string, payload: object) =>
    toItem(threadId, turn, type, payload)
  return [
    item('user_message', { text: promptText(turn) }),
    ...(turn.reasoning === ''
      ? []
      : [item('reasoning', { text: turn.reasoning })]),
    ...(turn.reply === ''
      ? []
      : [item('assistant_message', { text: replyText(turn) })]),
    ...(turn.sources.length === 0
      ? []
      : [item('web_sources', { sources: turn.sources })]),
  ]
}

const toArchivedThread = (chat: ListedChat, turns: Turn[]): ArchivedThread => {
  const items = turns
    .flatMap((turn) => toItems(chat.threadId, turn))
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
    // Stored like a Host's, but never compared: Gemini lists no Item count,
    // so a Thread counts as changed by its last update alone.
    signature: { updatedAt, itemCount: items.length, deleted: false },
    items,
  }
}

// Reading more per Sync risks Google throttling or flagging the account. A
// larger backlog drains over several Syncs.
const readCap = 30

/**
 * Archives the Threads Gemini lists whose last update changed since they were
 * last read, oldest first and at most `readCap` per Sync. Threads missing from
 * the list are kept.
 */
export const syncGemini = async (
  archive: Archive,
  collaborators: GeminiCollaborators,
) => {
  const gemini = await connectGemini(collaborators)
  archive.recordHost(geminiLabel, null)
  const stored = archive.signatures(geminiLabel)
  const isChanged = ({ threadId, updatedAt }: ListedChat) =>
    stored.get(threadId)?.updatedAt !== updatedAt.toISOString()

  // The list runs newest first, so paging stops at the first page without a
  // changed Thread. Reading oldest first keeps that stop correct mid-backlog:
  // every changed Thread left unread is newer than every one read.
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
  // Each Thread commits with its Signature, so an interrupted Sync re-reads
  // only what didn't land.
  for (const chat of toRead) {
    const turns = await gemini.readChat(chat.threadId)
    archive.saveThreads(geminiLabel, [toArchivedThread(chat, turns)])
  }
}
