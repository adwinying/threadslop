import type { Archive, ArchivedThread } from '~/archive'
import type { ListedChat } from '~/web'
import { extractSearchText } from '~/extract'

// Syncing a web app Source, Gemini or ChatGPT. Neither lists an Item count, so
// a Thread counts as changed by its last update alone.

/** An Item before its Thread numbers it. */
type ItemDraft = {
  /** Tells the Item apart from the Thread's other Items of its type. */
  key: string
  type: string
  payload: object
  at: Date
}

/** A listed chat as a Thread of its Item drafts, in order. */
export const toArchivedThread = (
  listed: ListedChat,
  createdAt: Date,
  drafts: ItemDraft[],
): ArchivedThread => {
  const updatedAt = listed.updatedAt.toISOString()
  const items = drafts.map(({ key, type, payload, at }, ordinal) => {
    const json = JSON.stringify(payload)
    const time = at.toISOString()
    return {
      // Stable across re-reads, so a re-read Thread updates its rows. Item IDs
      // are unique per Source, so the Thread ID keeps one Thread's Items from
      // ever replacing another's.
      id: `${listed.threadId}:${key}:${type}`,
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
    // Stored like a Host's, but never compared.
    signature: { updatedAt, itemCount: items.length, deleted: false },
    items,
  }
}

// Reading more per Sync risks the web app throttling or flagging the account.
// A larger backlog drains over several Syncs.
const readCap = 30

/**
 * Archives the Threads a web app lists whose last update changed since they
 * were last read, oldest first and at most `readCap` per Sync. Threads missing
 * from the lists are kept.
 */
export const syncWebApp = async ({
  archive,
  label,
  lists,
  read,
}: {
  archive: Archive
  /** The Source label its Threads are archived under. */
  label: string
  /** Each list the web app keeps, as its pages, newest first. */
  lists: AsyncIterable<ListedChat[]>[]
  /** Reads a listed chat as its Thread. */
  read: (listed: ListedChat) => Promise<ArchivedThread>
}) => {
  archive.recordHost(label, null)
  const stored = archive.signatures(label)
  const isChanged = ({ threadId, updatedAt }: ListedChat) =>
    stored.get(threadId)?.updatedAt !== updatedAt.toISOString()

  // Each list runs newest first, so its paging stops at the first page
  // without a changed Thread. Reading oldest first keeps that stop correct
  // mid-backlog: every changed Thread left unread is newer than every one read.
  const changed: ListedChat[] = []
  for (const pages of lists) {
    for await (const chats of pages) {
      const pageChanged = chats.filter(isChanged)
      if (pageChanged.length === 0) break
      changed.push(...pageChanged)
    }
  }

  const toRead = changed
    .toSorted((a, b) => +a.updatedAt - +b.updatedAt)
    .slice(0, readCap)
  // Each Thread commits with its Signature, so an interrupted Sync re-reads
  // only what didn't land.
  for (const listed of toRead) {
    archive.saveThreads(label, [await read(listed)])
  }
}
