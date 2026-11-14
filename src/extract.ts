import { z } from 'zod'

const messagePayloadSchema = z.object({ text: z.string() })

/** The text indexed for search, chosen by Item type. */
export const extractSearchText = (type: string, payload: string) => {
  switch (type) {
    case 'user_message':
    case 'assistant_message':
      return messagePayloadSchema.parse(JSON.parse(payload)).text
    default:
      return payload
  }
}
