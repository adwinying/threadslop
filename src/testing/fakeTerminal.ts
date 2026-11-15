import { PassThrough, Writable } from 'node:stream'

/**
 * Stands in for the tty `docker exec -it` gives: types the next answer after
 * each prompt and, like a real tty, echoes it to the screen unless raw mode is
 * on.
 */
export const createTerminal = (answers: string[], { isTTY = true } = {}) => {
  let raw = false
  let screen = ''
  const input = Object.assign(new PassThrough(), {
    isTTY,
    setRawMode: (mode: boolean) => {
      raw = mode
      return input
    },
  })
  const output = new Writable({
    write(chunk, _, done) {
      screen += String(chunk)
      const answer = screen.endsWith(': ') ? answers.shift() : undefined
      if (answer !== undefined) {
        setImmediate(() => {
          if (!raw) screen += answer.replace('\r', '\n')
          input.write(answer)
        })
      }
      done()
    },
  })
  return { input, output, screen: () => screen }
}
