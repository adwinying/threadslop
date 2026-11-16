import type { Archive } from '~/archive'
import type { GeminiCollaborators, Turn } from '~/gemini'
import { connectGemini, geminiLabel } from '~/gemini'
import { syncWebApp, toArchivedThread } from '~/webSync'

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

/**
 * A turn's Items, each keyed by the turn's response ID. That ID's position is
 * a guess, so the Thread ID in each Item ID keeps a wrong guess from replacing
 * another Thread's Items.
 */
const toItemDrafts = (turn: Turn) => {
  const item = (type: string, payload: object) => ({
    key: turn.responseId,
    type,
    payload,
    at: turn.at,
  })
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

type Gemini = Awaited<ReturnType<typeof connectGemini>>

/** The pages of the chats, newest first. */
async function* listPages(gemini: Gemini) {
  let pageToken: string | undefined
  do {
    const page = await gemini.listChats(pageToken)
    yield page.chats
    pageToken = page.nextPageToken
  } while (pageToken !== undefined)
}

/** Archives the Gemini Threads whose last update changed, as `syncWebApp` does. */
export const syncGemini = async (
  archive: Archive,
  collaborators: GeminiCollaborators,
) => {
  const gemini = await connectGemini(collaborators)
  await syncWebApp({
    archive,
    label: geminiLabel,
    lists: [listPages(gemini)],
    read: async (listed) => {
      const turns = await gemini.readChat(listed.threadId)
      return toArchivedThread(
        listed,
        turns[0]?.at ?? listed.updatedAt,
        turns.flatMap(toItemDrafts),
      )
    },
  })
}
