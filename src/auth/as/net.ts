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
 * Parses a textual IPv6 address (RFC 4291 forms: `::` compression and an
 * optional embedded dotted-quad IPv4 tail, in either hex-group or literal
 * dotted form) into its 16 raw bytes. Returns `null` for anything malformed
 * so callers can fail closed rather than guess.
 */
function parseIPv6Bytes(ip: string): number[] | null {
  const doubleColonAt = ip.indexOf('::');
  if (doubleColonAt !== -1 && ip.indexOf('::', doubleColonAt + 1) !== -1) return null;

  const head = doubleColonAt === -1 ? ip : ip.slice(0, doubleColonAt);
  const tail = doubleColonAt === -1 ? '' : ip.slice(doubleColonAt + 2);
  const headParts = head.length ? head.split(':') : [];
  const tailParts = tail.length ? tail.split(':') : [];

  let ipv4Tail: number[] | null = null;
  const lastParts = tailParts.length ? tailParts : headParts;
  const last = lastParts[lastParts.length - 1];
  if (last?.includes('.')) {
    const octets = last.split('.');
    if (octets.length !== 4) return null;
    ipv4Tail = octets.map(Number);
    if (ipv4Tail.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
    lastParts.pop();
  }

  const parseGroups = (parts: string[]): number[] | null => {
    const groups: number[] = [];
    for (const part of parts) {
      if (part === '' || !/^[0-9a-f]{1,4}$/i.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const headGroups = parseGroups(headParts);
  const tailGroups = parseGroups(tailParts);
  if (!headGroups || !tailGroups) return null;
  if (ipv4Tail) {
    tailGroups.push(((ipv4Tail[0] ?? 0) << 8) | (ipv4Tail[1] ?? 0));
    tailGroups.push(((ipv4Tail[2] ?? 0) << 8) | (ipv4Tail[3] ?? 0));
  }

  const total = headGroups.length + tailGroups.length;
  if (doubleColonAt === -1 ? total !== 8 : total > 8) return null;
  const zeros = doubleColonAt === -1 ? 0 : 8 - total;
  const groups = [...headGroups, ...Array(zeros).fill(0), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

function bytesHavePrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== (prefix[i] ?? 0)) return false;
  }
  const remainder = bits % 8;
  if (remainder > 0) {
    const mask = (0xff << (8 - remainder)) & 0xff;
    if (((bytes[fullBytes] ?? 0) & mask) !== ((prefix[fullBytes] ?? 0) & mask)) return false;
  }
  return true;
}

// RFC 6890 / RFC 4291 IPv6 special-purpose prefixes that don't embed an IPv4
// address needing separate evaluation (those — IPv4-mapped/-compatible —
// are handled by recursing into `assertPublicAddress` below instead).
const V6_SPECIAL_PREFIXES: ReadonlyArray<readonly [number[], number]> = [
  [[0xfe, 0x80], 10], // Link-Local Unicast
  [[0xfc], 7], // Unique-Local
  [[0xff], 8], // Multicast
  [[0x20, 0x01, 0x0d, 0xb8], 32], // Documentation
  [[0x00, 0x64, 0xff, 0x9b], 96], // IPv4-IPv6 Translation (NAT64)
  [[0x20, 0x01], 23], // IETF Protocol Assignments
  [[0x20, 0x02], 16], // 6to4 (embeds IPv4; rejected outright regardless)
  [[0x01, 0x00], 64], // Discard-Only
];

function v6IsSpecial(bytes: number[]): boolean {
  if (bytes.every((b) => b === 0)) return true; // :: (Unspecified)
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1 (Loopback)

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96 with the low 32
  // bits non-zero) both embed an IPv4 address in the last 4 bytes — defer to
  // the IPv4 rules on that embedded address rather than a blanket verdict.
  const highZero = bytes.slice(0, 10).every((b) => b === 0);
  const isMapped = highZero && bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompatible = highZero && bytes[10] === 0 && bytes[11] === 0;
  if (isMapped || isCompatible) {
    const embeddedV4 = bytes.slice(12, 16).join('.');
    try {
      assertPublicAddress(embeddedV4);
      return false;
    } catch {
      return true;
    }
  }

  return V6_SPECIAL_PREFIXES.some(([prefix, bits]) => bytesHavePrefix(bytes, prefix, bits));
}

/**
 * Throws when `ip` falls in an RFC 6890 special-use range (loopback, private,
 * link-local, CGNAT, documentation, multicast, reserved, etc.) for either
 * IPv4 or IPv6, including non-canonical IPv6 spellings (e.g.
 * `::ffff:7f00:1`, `0064:ff9b::7f00:1`) — classification is done on the
 * parsed 16 raw bytes, never on the string form, so it can't be bypassed by
 * an unusual but valid textual representation. Used to block SSRF via DNS
 * rebinding after a hostname has been resolved to a concrete address.
 */
export function assertPublicAddress(ip: string): void {
  const family = isIP(ip);
  if (family === 4) {
    if (v4IsSpecial(ip)) throw new Error(`refusing special-use address ${ip}`);
    return;
  }
  if (family === 6) {
    const bytes = parseIPv6Bytes(ip);
    if (!bytes || v6IsSpecial(bytes)) throw new Error(`refusing special-use address ${ip}`);
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
 * whatever DNS resolution would otherwise return — this is what makes the
 * fetch safe against DNS-rebinding after `assertPublicAddress` has already
 * vetted `opts.ip`. `agent: false` disables keep-alive pooling so a later
 * fetch to the same host can never reuse a socket from a stale lookup.
 * Never follows redirects; the caller decides how to treat any non-200
 * status. Aborts once more than `maxBytes` have arrived.
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
    const family = opts.ip.includes(':') ? 6 : 4;
    // node:net's `lookupAndConnect` calls this with a `dnsopts` object whose
    // shape depends on whether autoSelectFamily is active (the default on
    // modern Node for non-literal-IP hosts): when `options.all` is set it
    // wants `callback(err, [{ address, family }])`; otherwise the classic
    // `callback(err, address, family)`. Ignoring `all` breaks every fetch to
    // a real hostname ("Invalid IP address: undefined"), since Node then
    // tries to read `.address` off a bare string. @types/node's `lookup`
    // option type is the overloaded `dns.lookup` signature, which can't
    // structurally match one implementation handling both shapes — hence
    // the single cast through `unknown` below.
    const lookup = (
      _hostname: string,
      lookupOptions: { all?: boolean } | null | undefined,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ) => {
      if (lookupOptions?.all) {
        callback(null, [{ address: opts.ip, family }]);
      } else {
        callback(null, opts.ip, family);
      }
    };
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', host: url.host },
        servername: url.hostname,
        timeout: opts.timeoutMs,
        agent: false,
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
