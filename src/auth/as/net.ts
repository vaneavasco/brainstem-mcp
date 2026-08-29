import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const V4_SPECIAL_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0);
}

const V4_SPECIAL: ReadonlyArray<readonly [number, number]> = V4_SPECIAL_RANGES.map(
  ([cidr, bits]) => [v4ToInt(cidr), bits] as const,
);

function v4IsSpecial(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_SPECIAL.some(
    ([base, bits]) => bits === 0 || n >>> (32 - bits) === base >>> (32 - bits),
  );
}

/**
 * Throws when `ip` falls in an RFC 6890 special-use range (loopback, private,
 * link-local, CGNAT, documentation, multicast, reserved, etc.) for either
 * IPv4 or IPv6, including IPv4-mapped IPv6 addresses. Used to block SSRF via
 * DNS rebinding after a hostname has been resolved to a concrete address.
 */
export function assertPublicAddress(ip: string): void {
  const family = isIP(ip);
  if (family === 4) {
    if (v4IsSpecial(ip)) throw new Error(`refusing special-use address ${ip}`);
    return;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) {
      assertPublicAddress(mapped[1]);
      return;
    }
    const isSpecial =
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff') ||
      lower.startsWith('2001:db8') ||
      lower.startsWith('64:ff9b');
    if (isSpecial) throw new Error(`refusing special-use address ${ip}`);
    return;
  }
  throw new Error(`refusing special-use address ${ip}`);
}

export interface FetchedDocument {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FetchDocumentOptions {
  timeoutMs: number;
  maxBytes: number;
  ip: string;
  allowInsecureHttp?: boolean;
}

/**
 * Fetches a document over HTTPS (or plain HTTP when `allowInsecureHttp` is
 * set, for tests), with the connection pinned to `opts.ip` rather than
 * whatever the resolver's own DNS lookup would return — this is what makes
 * the fetch safe against DNS-rebinding after `assertPublicAddress` has
 * already vetted `opts.ip`. Never follows redirects; the caller decides how
 * to treat any non-200 status. Aborts once more than `maxBytes` have
 * arrived.
 */
export function fetchClientMetadataDocument(
  url: URL,
  opts: FetchDocumentOptions,
): Promise<FetchedDocument> {
  const insecure = url.protocol === 'http:';
  if (insecure && !opts.allowInsecureHttp) {
    return Promise.reject(new Error('client metadata must be served over https'));
  }
  const mod = insecure ? http : https;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const lookup = (
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      callback(null, opts.ip, opts.ip.includes(':') ? 6 : 4);
    };
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', host: url.host },
        servername: url.hostname,
        timeout: opts.timeoutMs,
        // node:http/https types the `lookup` callback with the dns.lookup
        // multi-address overload signature; the single-address form above is
        // valid at runtime but not expressible in the declared type, hence
        // the cast through `unknown`.
        lookup: lookup as unknown as typeof import('node:dns').lookup,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('error', (err) => settle(() => reject(err)));
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            const err = new Error(`document larger than ${opts.maxBytes} bytes`);
            settle(() => reject(err));
            // Destroy the response (not the request): when the full body
            // has already arrived in one chunk, destroying `req` still lets
            // this stream's buffered 'end' fire and can surface the abort
            // error as an uncaught exception instead of a `req`/`res`
            // 'error' event.
            res.destroy(err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout fetching client metadata')));
    req.on('error', (err) => settle(() => reject(err)));
    req.end();
  });
}
