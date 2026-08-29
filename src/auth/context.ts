import type { RuntimeResolver, VaultRuntime } from '../vault/runtime.ts';

export function createOwnerResolver(runtime: VaultRuntime): RuntimeResolver {
  return async (ctx) => {
    if (ctx.authInfo?.extra?.userId !== 'owner') {
      throw new Error('unauthenticated request reached the tool layer');
    }
    return runtime;
  };
}
