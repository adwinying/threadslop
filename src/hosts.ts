import { z } from 'zod'

// No leading dash in either part, so ssh never reads an entry as an option.
const destinationPattern = /^[\w.][\w.-]*@[a-z\d][a-z\d.-]*$/i

const hostSchema = z
  .string()
  .regex(destinationPattern, 'must be user@host')
  .transform((destination) => ({
    /** The hostname part, which identifies the Host in the archive. */
    label: destination.slice(destination.indexOf('@') + 1),
    /** The `user@host` ssh destination. */
    destination,
  }))

/** A comma-separated list of `user@host` entries. */
export const hostListSchema = z
  .string()
  .transform((value) => value.split(',').map((entry) => entry.trim()))
  .pipe(z.array(hostSchema))
  .refine(
    (hosts) => new Set(hosts.map(({ label }) => label)).size === hosts.length,
    'hostnames must be unique',
  )

export type Host = z.infer<typeof hostSchema>

export type QueryOperation = 'signatures' | 'threads'

/** Runs a query operation on a Host and resolves with its stdout. */
export type HostTransport = (
  host: Host,
  operation: QueryOperation,
  stdin?: string,
) => Promise<string>
