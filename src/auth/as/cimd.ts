import type { Logger } from '../../logger.ts';
import type { ClientRecord, TokenStore } from '../store/types.ts';

export interface CimdResolver {
  resolveClient(clientId: string): Promise<ClientRecord>;
}

export interface CimdResolverOptions {
  allowedHosts: string[];
  store: TokenStore;
  now: () => number;
  logger: Logger;
}

/** Stub — replaced by the real Client ID Metadata Document resolver in Task 7. */
export function createCimdResolver(_opts: CimdResolverOptions): CimdResolver {
  return {
    async resolveClient() {
      throw new Error('CIMD resolver is implemented in Task 7');
    },
  };
}
