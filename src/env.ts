import { createEnv } from '@t3-oss/env-core'
import { hostListSchema } from '~/hosts'

export const createEnvironment = (
  runtimeEnv: Record<string, string | undefined>,
) =>
  createEnv({
    server: { HOSTS: hostListSchema },
    runtimeEnv,
    emptyStringAsUndefined: true,
  })
