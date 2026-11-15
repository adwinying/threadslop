import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { geminiLabel } from '~/gemini'

// No leading dash in either part, so ssh never reads an entry as an option.
const destinationPattern = /^[\w.][\w.-]*@[a-z\d][a-z\d.-]*$/i

export const hostSchema = z
  .string()
  .regex(destinationPattern, 'must be user@host')
  .transform((entry) => {
    const at = entry.indexOf('@')
    // Hostnames are case-insensitive, so `hivE` names the same Host as `hive`.
    const label = entry.slice(at + 1).toLowerCase()
    return {
      /** The lowercased hostname part, which identifies the Host in the archive. */
      label,
      destination: `${entry.slice(0, at)}@${label}`,
    }
  })
  // Labels name Sources in the archive, so no Host may take Gemini's.
  .refine(
    ({ label }) => label !== geminiLabel,
    `uses ${geminiLabel}, reserved for Gemini`,
  )

export type Host = z.infer<typeof hostSchema>

/** The Host list in the data directory, re-read by every Sync. */
export const hostsFile = (dataDir: string) => join(dataDir, 'hosts')

const header = `# Hosts threadslop syncs, one user@host per line. Edits apply on the next Sync.
# Add a Host with: docker exec -it threadslop threadslop install-host <user@host>
`

export const ensureHostsFile = (dataDir: string) => {
  if (!existsSync(hostsFile(dataDir))) {
    writeFileSync(hostsFile(dataDir), header)
  }
}

/** Reads the Host list. Throws naming the first malformed line. */
export const readHosts = (dataDir: string) => {
  const file = hostsFile(dataDir)
  const hosts: Host[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    const entry = line.replace(/#.*/, '').trim()
    if (entry === '') continue
    const invalid = (reason: string) =>
      new Error(`${file} line ${index + 1}: ${entry} ${reason}`)
    const host = hostSchema.safeParse(entry)
    if (!host.success) throw invalid(host.error.issues[0]?.message ?? '')
    if (hosts.some(({ label }) => label === host.data.label)) {
      throw invalid(`repeats the hostname ${host.data.label}`)
    }
    hosts.push(host.data)
  }
  return hosts
}

/** Appends a Host on a line of its own. */
export const appendHost = (dataDir: string, { destination }: Host) => {
  const content = readFileSync(hostsFile(dataDir), 'utf8')
  const separator = content === '' || content.endsWith('\n') ? '' : '\n'
  appendFileSync(hostsFile(dataDir), `${separator}${destination}\n`)
}

export type QueryOperation = 'signatures' | 'threads'

/** Runs a query operation on a Host and resolves with its stdout. */
export type HostTransport = (
  host: Host,
  operation: QueryOperation,
  stdin?: string,
) => Promise<string>
