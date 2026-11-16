import type { Archive, ArchivedThread } from '~/archive'
import type { Chat, ChatGPTCollaborators, ListedChat } from '~/chatgpt'
import { chatgptLabel, connectChatGPT } from '~/chatgpt'
import { extractSearchText } from '~/extract'

const toArchivedThread = (
  listed: ListedChat,
  { createdAt, drafts }: Chat,
): ArchivedThread => {
  const updatedAt = listed.updatedAt.toISOString()
  const items = drafts.map(({ messageId, type, payload, at }, ordinal) => {
    const json = JSON.stringify(payload)
    const time = (at ?? createdAt).toISOString()
    return {
      // Stable across re-reads, so a re-read Thread updates its rows. Item IDs
      // are unique per Source, so the Thread ID keeps one Thread's Items from
      // ever replacing another's.
      id: `${listed.threadId}:${messageId}:${type}`,
      type,
      status: 'completed',
      ordinal,
      createdAt: time,
      completedAt: time,
      updatedAt: time,
      payload: json,
      searchText: extractSearchText(type, json),
    }
  })
  return {
    id: listed.threadId,
    title: listed.title,
    projectTitle: null,
    workspaceRoot: null,
    createdAt: createdAt.toISOString(),
    updatedAt,
    archivedAt: null,
    // Stored like a Host's, but never compared: ChatGPT lists no Item count,
    // so a Thread counts as changed by its last update alone.
    signature: { updatedAt, itemCount: items.length, deleted: false },
    items,
  }
}

// Reading more per Sync risks chatgpt.com throttling or flagging the account.
// A larger backlog drains over several Syncs.
const readCap = 30

/**
 * Archives the Threads ChatGPT lists, active and archived, whose last update
 * changed since they were last read, oldest first and at most `readCap` per
 * Sync. Threads missing from the list are kept.
 */
export const syncChatGPT = async (
  archive: Archive,
  collaborators: ChatGPTCollaborators,
) => {
  const chatgpt = await connectChatGPT(collaborators)
  archive.recordHost(chatgptLabel, null)
  const stored = archive.signatures(chatgptLabel)
  const isChanged = ({ threadId, updatedAt }: ListedChat) =>
    stored.get(threadId)?.updatedAt !== updatedAt.toISOString()

  // Each list runs newest first, so its paging stops at the first page
  // without a changed Thread. Reading oldest first keeps that stop correct
  // mid-backlog: every changed Thread left unread is newer than every one read.
  const changed: ListedChat[] = []
  for (const archived of [false, true]) {
    let offset: number | undefined = 0
    while (offset !== undefined) {
      const page = await chatgpt.listChats({ offset, archived })
      const pageChanged = page.chats.filter(isChanged)
      if (pageChanged.length === 0) break
      changed.push(...pageChanged)
      offset = page.nextOffset
    }
  }

  const toRead = changed
    .toSorted((a, b) => +a.updatedAt - +b.updatedAt)
    .slice(0, readCap)
  // Each Thread commits with its Signature, so an interrupted Sync re-reads
  // only what didn't land.
  for (const listed of toRead) {
    const chat = await chatgpt.readChat(listed.threadId)
    archive.saveThreads(chatgptLabel, [toArchivedThread(listed, chat)])
  }
}
