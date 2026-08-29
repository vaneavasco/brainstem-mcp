export const TEST_OWNER_SECRET = 'dGVzdC1vd25lci1zZWNyZXQtMzItYnl0ZXMtbG9uZy0hIQ';

export function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    PUBLIC_URL: 'https://brainstem.example.com',
    OWNER_SECRET: TEST_OWNER_SECRET,
    STORAGE_BACKEND: 'localfs',
    VAULT_PATH: '/tmp/unused',
    ...over,
  };
}
