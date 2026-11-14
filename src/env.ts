import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'
import { hostListSchema } from '~/hosts'

export const createEnvironment = (
  runtimeEnv: Record<string, string | undefined>,
) =>
  createEnv({
    server: {
      HOSTS: hostListSchema,
      /** Holds the archive, the SSH key and `known_hosts`. */
      DATA_DIR: z.string().min(1).default('./data'),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
  })
