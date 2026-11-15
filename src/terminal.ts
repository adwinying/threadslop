/** The tty an install command prompts at. Tests swap in a stand-in. */
export type Terminal = {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean
    setRawMode?: (mode: boolean) => unknown
  }
  output: NodeJS.WritableStream
}

const enter = new Set(['\r', '\n'])
const cancel = new Set(['\u0003', '\u0004']) // Ctrl-C, Ctrl-D
const erase = new Set(['\u007f', '\b'])

/**
 * A prompt that reads a line at the tty in raw mode, so the tty doesn't echo
 * it, resolving with undefined when cancelled. Undefined without a tty, where
 * nothing can stop the echo.
 */
export const hiddenPrompt = ({ input, output }: Terminal) => {
  if (!input.isTTY || input.setRawMode === undefined) return undefined
  const setRawMode = input.setRawMode.bind(input)
  return (question: string) =>
    new Promise<string | undefined>((resolve) => {
      let answer = ''
      const finish = (result: string | undefined) => {
        input.off('data', onData)
        setRawMode(false)
        input.pause()
        output.write('\n')
        resolve(result)
      }
      const onData = (chunk: Buffer | string) => {
        for (const char of String(chunk)) {
          if (enter.has(char)) return finish(answer.trim())
          if (cancel.has(char)) return finish(undefined)
          answer = erase.has(char) ? answer.slice(0, -1) : answer + char
        }
      }
      setRawMode(true)
      input.on('data', onData)
      input.resume()
      output.write(question)
    })
}
