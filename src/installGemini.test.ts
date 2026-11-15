import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installGemini } from '~/installGemini'
import { createFakeGemini } from '~/testing/fakeGemini'
import { createTestApp } from '~/testing/fakeHost'
import { createTerminal } from '~/testing/fakeTerminal'

const setup = () => {
  const gemini = createFakeGemini()
  const testApp = createTestApp({ hosts: [], fetch: gemini.fetch })
  const sessionFile = join(testApp.root, 'gemini-session.json')
  return {
    gemini,
    testApp,
    sessionMode: () => statSync(sessionFile).mode & 0o777,
    session: () => readFileSync(sessionFile, 'utf8'),
    install: (
      answers: string[],
      { args = [], isTTY = true }: { args?: string[]; isTTY?: boolean } = {},
    ) => {
      const terminal = createTerminal(answers, { isTTY })
      return {
        terminal,
        exitCode: installGemini(args, {
          env: { DATA_DIR: testApp.root },
          fetch: gemini.fetch,
          input: terminal.input,
          output: terminal.output,
        }),
      }
    },
  }
}

let log: ReturnType<typeof spyOn>
let error: ReturnType<typeof spyOn>
beforeEach(() => {
  log = spyOn(console, 'log').mockImplementation(() => undefined)
  error = spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  log.mockRestore()
  error.mockRestore()
})

describe('threadslop install-gemini', () => {
  test('stores cookies that sign in, readable by its owner only, so the next Sync includes Gemini', async () => {
    const { gemini, testApp, sessionMode, install } = setup()
    gemini.putChat({
      id: '8f1e2d3c4b5a6978',
      title: 'Sourdough starter',
      updatedAt: '2026-11-02T09:00:00.000Z',
      turns: [
        {
          responseId: 'r_first',
          prompt: 'How often should I feed a sourdough starter?',
          reply: 'Once a day.',
          at: '2026-11-02T09:00:00.000Z',
        },
      ],
    })

    expect(await install(['fake-psid\r', 'fake-psidts\r']).exitCode).toBe(0)
    expect(sessionMode()).toBe(0o600)

    await testApp.sync()
    const response = await testApp.handle('/threads/gemini/8f1e2d3c4b5a6978')
    expect(response.status).toBe(200)
  })

  test("doesn't echo the cookies", async () => {
    const { install } = setup()

    const { terminal, exitCode } = install(['fake-psid\r', 'fake-psidts\r'])
    await exitCode

    expect(terminal.screen()).toBe(
      '__Secure-1PSID (from Firefox): \n__Secure-1PSIDTS (from Firefox): \n',
    )
  })

  test('refuses cookies that are signed out, keeping the stored session', async () => {
    const { gemini, testApp, session, install } = setup()
    gemini.storeSession(testApp.root, { rotatedAt: new Date('2026-11-01') })
    const stored = session()

    expect(await install(['stale-psid\r', 'stale-psidts\r']).exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      "threadslop: those cookies don't sign in to Gemini",
    )
    expect(session()).toBe(stored)
  })

  test('names the status when Gemini fails the check, rather than blaming the cookies', async () => {
    const { gemini, testApp, session, install } = setup()
    gemini.storeSession(testApp.root)
    const stored = session()
    gemini.failAppPage(503)

    expect(await install(['fake-psid\r', 'fake-psidts\r']).exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      'threadslop: Gemini answered the app page with HTTP 503',
    )
    expect(session()).toBe(stored)
  })

  test('refuses to prompt without a tty, where the cookies would echo', async () => {
    const { gemini, testApp, session, install } = setup()
    gemini.storeSession(testApp.root)
    const stored = session()

    const { terminal, exitCode } = install(['fake-psid\r', 'fake-psidts\r'], {
      isTTY: false,
    })

    expect(await exitCode).toBe(1)
    expect(terminal.screen()).toBe('')
    expect(session()).toBe(stored)
  })

  test('prints usage given arguments', async () => {
    const { install } = setup()

    expect(await install([], { args: ['--help'] }).exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith('Usage: threadslop install-gemini')
  })
})
