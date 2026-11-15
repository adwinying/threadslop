import type { Archive, Signature } from '~/archive'
import type { Host, HostTransport } from '~/hosts'
import { z } from 'zod'
import { extractSearchText } from '~/extract'

const signaturesSchema = z.object({
  environmentId: z.string().min(1),
  threads: z.array(
    z.object({
      id: z.string(),
      updatedAt: z.string(),
      itemCount: z.number(),
      deleted: z.boolean(),
    }),
  ),
  skipped: z.number(),
})

const threadsSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      projectTitle: z.string().nullable(),
      workspaceRoot: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      archivedAt: z.string().nullable(),
      items: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          status: z.string(),
          ordinal: z.number(),
          createdAt: z.string(),
          completedAt: z.string().nullable(),
          updatedAt: z.string(),
          payload: z.string(),
        }),
      ),
    }),
  ),
})

type ReportedSignature = Signature & { id: string }

// Caps each `threads` response: a first Sync of a large Host would otherwise
// return every Item in one JSON document.
const itemsPerBatch = 1000

const isUnchanged = (
  stored: Signature | undefined,
  reported: ReportedSignature,
) =>
  stored?.updatedAt === reported.updatedAt &&
  stored.itemCount === reported.itemCount &&
  stored.deleted === reported.deleted

const batchByItemCount = (changed: ReportedSignature[]) => {
  const batches: ReportedSignature[][] = []
  let batch: ReportedSignature[] = []
  let items = 0
  for (const signature of changed) {
    if (batch.length > 0 && items + signature.itemCount > itemsPerBatch) {
      batches.push(batch)
      batch = []
      items = 0
    }
    batch.push(signature)
    items += signature.itemCount
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

const toArchivedThread = (
  { items, ...thread }: z.infer<typeof threadsSchema>['threads'][number],
  signature: Signature,
) => ({
  ...thread,
  signature,
  items: items.map((item) => ({
    ...item,
    searchText: extractSearchText(item.type, item.payload),
  })),
})

export const syncHost = async (
  archive: Archive,
  transport: HostTransport,
  host: Host,
) => {
  const {
    environmentId,
    threads: reported,
    skipped,
  } = signaturesSchema.parse(JSON.parse(await transport(host, 'signatures')))
  archive.recordHost(host.label, environmentId)
  if (skipped > 0) {
    console.warn(
      `threadslop: ${host.label} skipped ${skipped} Thread${skipped === 1 ? '' : 's'} with an unsafe ID`,
    )
  }

  const stored = archive.signatures(host.label)
  const changed = reported.filter(
    (signature) => !isUnchanged(stored.get(signature.id), signature),
  )

  archive.removeThreads(
    host.label,
    new Map(
      changed
        .filter(({ deleted }) => deleted)
        .map(({ id, ...signature }) => [id, signature]),
    ),
  )

  const live = changed.filter(({ deleted }) => !deleted)
  // One transaction per batch, not per Host: a first Sync of a large Host
  // would be one huge transaction. Each Thread still commits atomically with
  // its Signature, so an interrupted Sync re-pulls only what didn't land.
  for (const batch of batchByItemCount(live)) {
    const signatures = new Map(
      batch.map(({ id, ...signature }) => [id, signature]),
    )
    const { threads } = threadsSchema.parse(
      JSON.parse(
        await transport(
          host,
          'threads',
          JSON.stringify([...signatures.keys()]),
        ),
      ),
    )
    archive.saveThreads(
      host.label,
      threads.flatMap((thread) => {
        const signature = signatures.get(thread.id)
        return signature ? [toArchivedThread(thread, signature)] : []
      }),
    )
  }
}

/** A Source to Sync: a Host, Gemini, or ChatGPT. */
export type Source = { label: string; sync: () => Promise<void> }

/** Syncs every Source in turn. A failing Source is recorded and skipped. */
export const syncAll = async (
  archive: Archive,
  sources: Source[],
  clock: () => Date,
) => {
  for (const { label, sync } of sources) {
    try {
      await sync()
      archive.recordSuccess(label, clock())
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      archive.recordFailure(label, error, clock())
    }
  }
}
