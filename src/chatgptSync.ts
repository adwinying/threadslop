import type { Archive } from '~/archive'
import type { ChatGPTCollaborators } from '~/chatgpt'
import { chatgptLabel, connectChatGPT } from '~/chatgpt'
import { syncWebApp, toArchivedThread } from '~/webSync'

type ChatGPT = Awaited<ReturnType<typeof connectChatGPT>>

/** The pages of the active or the archived chats, newest first. */
async function* listPages(chatgpt: ChatGPT, archived: boolean) {
  let offset: number | undefined = 0
  while (offset !== undefined) {
    const page = await chatgpt.listChats({ offset, archived })
    yield page.chats
    offset = page.nextOffset
  }
}

/**
 * Archives the ChatGPT Threads whose last update changed, active and archived,
 * as `syncWebApp` does.
 */
export const syncChatGPT = async (
  archive: Archive,
  collaborators: ChatGPTCollaborators,
) => {
  const chatgpt = await connectChatGPT(collaborators)
  await syncWebApp({
    archive,
    label: chatgptLabel,
    lists: [listPages(chatgpt, false), listPages(chatgpt, true)],
    read: async (listed) => {
      const { createdAt, drafts } = await chatgpt.readChat(listed.threadId)
      return toArchivedThread(listed, createdAt, drafts)
    },
  })
}
