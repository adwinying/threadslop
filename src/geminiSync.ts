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

const toItems = (turn: Turn) => [
  toItem(turn, 'user_message', { text: turn.prompt }),
  ...(turn.reply === ''
    ? []
    : [toItem(turn, 'assistant_message', { text: turn.reply })]),
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

/**
 * Archives the chats Gemini lists whose last update changed since they were
 * last read. Chats missing from the list are kept.
 */
export const syncGemini = async (
  archive: Archive,
  collaborators: { dataDir: string; fetch: Fetch; clock: () => Date },
) => {
  const gemini = await connectGemini(collaborators)
  archive.recordHost(geminiLabel, null)
  const stored = archive.signatures(geminiLabel)

  const { chats } = await gemini.listChats()
  const changed = chats.filter(
    ({ threadId, updatedAt }) =>
      stored.get(threadId)?.updatedAt !== updatedAt.toISOString(),
  )
  // Each chat commits with its Signature, so an interrupted Sync re-reads
  // only what didn't land.
  for (const chat of changed) {
    const turns = await gemini.readChat(chat.threadId)
    archive.saveThreads(geminiLabel, [toArchivedThread(chat, turns)])
  }
}
