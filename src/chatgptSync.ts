import type { ChatGPTCollaborators } from '~/chatgpt'
import { connectChatGPT } from '~/chatgpt'

/**
 * The spike (#34): lists every chat, active then archived, and saves nothing.
 * Its successes and failures in /health show whether Cloudflare lets plain
 * `fetch` through and whether the session survives unattended.
 */
export const syncChatGPT = async (collaborators: ChatGPTCollaborators) => {
  const chatgpt = await connectChatGPT(collaborators)
  for (const archived of [false, true]) {
    let offset: number | undefined = 0
    while (offset !== undefined) {
      const page = await chatgpt.listChats({ offset, archived })
      offset = page.nextOffset
    }
  }
}
