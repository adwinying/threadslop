import type { Database } from 'bun:sqlite'
import { rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Writes a consistent copy of the archive to `threadslop.backup.sqlite` beside
 * the database file, for kopia to back up.
 */
export const snapshot = async (db: Database) => {
  const backup = join(dirname(db.filename), 'threadslop.backup.sqlite')
  const temp = `${backup}.tmp`
  // VACUUM INTO refuses to overwrite, e.g. a temp file left by a crash.
  await rm(temp, { force: true })
  db.prepare('VACUUM INTO ?').run(temp)
  // Same directory, so the rename is atomic and kopia never sees a partial file.
  await rename(temp, backup)
}
