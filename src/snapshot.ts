import type { Database } from 'bun:sqlite'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Writes a consistent copy of the archive to `threadslop.backup.sqlite` in the
 * data directory, for kopia to back up.
 */
export const snapshot = async (db: Database, dataDir: string) => {
  const snapshotFile = join(dataDir, 'threadslop.backup.sqlite')
  const tempFile = `${snapshotFile}.tmp`
  // VACUUM INTO refuses to overwrite, e.g. a temp file left by a crash.
  await rm(tempFile, { force: true })
  db.prepare('VACUUM INTO ?').run(tempFile)
  // Same directory, so the rename is atomic and kopia never sees a partial file.
  await rename(tempFile, snapshotFile)
}
