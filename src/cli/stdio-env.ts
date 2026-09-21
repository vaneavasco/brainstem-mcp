/** Settings of the HTTP server that the stdio server must never be handed: it has no use for
 *  them, and a secret that is not there cannot leak into a log or a child process. */
const HTTP_ONLY = new Set(['OWNER_SECRET', 'TUNNEL_TOKEN']);

/**
 * The environment `./brainstem stdio` starts the server with: the install's `.env` (the vault
 * path, time zone, daily-note folder and format the owner already chose) with the process
 * environment on top, so a client can override one setting (`claude mcp add -e …`). An empty
 * value in the process environment is an unset variable passed through, not an override.
 */
export function stdioEnv(
  file: Map<string, string> | null,
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = Object.fromEntries(file ?? []);
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== '') env[key] = value;
  }
  for (const key of HTTP_ONLY) delete env[key];
  return env;
}
