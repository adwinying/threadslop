import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const createEnvironment = (
  runtimeEnv: Record<string, string | undefined>,
) =>
  createEnv({
    server: {
      /** Holds the archive, the Host list, the SSH key and `known_hosts`. */
      DATA_DIR: z.string().min(1).default('./data'),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
  })
