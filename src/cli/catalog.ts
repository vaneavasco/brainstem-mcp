/** One group heading in the printed help text and the README's command table. */
export type CommandGroup = 'Everyday' | 'Configuration' | 'Maintenance';

/** Describes one registered top-level `brainstem` command. */
export interface CommandInfo {
  name: string;
  group: CommandGroup;
  summary: string;
  example: string;
}

/**
 * The single source of truth for every top-level `brainstem` command: its
 * group, one-line summary and a runnable example. `brainstem.ts` pulls each
 * command's `.description()` from here and `renderHelpText()` renders the
 * grouped list appended after `--help`; `tests/cli/catalog.test.ts` asserts
 * this list and the commands actually registered on the `commander` program
 * are the same set, in both directions. `secret` counts as one entry even
 * though it has `show`/`rotate` subcommands.
 */
export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'start',
    group: 'Everyday',
    summary: 'Check prerequisites, configure on first run, then start brainstem-mcp',
    example: './brainstem start',
  },
  {
    name: 'up',
    group: 'Everyday',
    summary: 'Start brainstem-mcp (docker compose up) and wait until it is healthy',
    example: './brainstem up',
  },
  {
    name: 'down',
    group: 'Everyday',
    summary: 'Stop brainstem-mcp',
    example: './brainstem down',
  },
  {
    name: 'status',
    group: 'Everyday',
    summary: 'Show configuration, health and container status',
    example: './brainstem status',
  },
  {
    name: 'url',
    group: 'Everyday',
    summary: 'Print the connector/public URL and check it is reachable',
    example: './brainstem url',
  },
  {
    name: 'logs',
    group: 'Everyday',
    summary: 'Follow container logs',
    example: './brainstem logs',
  },
  {
    name: 'setup',
    group: 'Configuration',
    summary: 'Create or update .env (owner secret, vault path, tunnel mode)',
    example: './brainstem setup --vault ~/Documents/Vault',
  },
  {
    name: 'secret',
    group: 'Configuration',
    summary: 'Show or rotate the owner secret',
    example: './brainstem secret show',
  },
  {
    name: 'update',
    group: 'Maintenance',
    summary: 'Pull the latest release, reinstall dependencies and restart',
    example: './brainstem update',
  },
  {
    name: 'doctor',
    group: 'Maintenance',
    summary: 'Check prerequisites and configuration; explain how to fix any issues',
    example: './brainstem doctor',
  },
  {
    name: 'revoke-all',
    group: 'Maintenance',
    summary: 'Revoke all OAuth tokens — every connected client must reconnect',
    example: './brainstem revoke-all',
  },
];

const GROUPS: readonly CommandGroup[] = ['Everyday', 'Configuration', 'Maintenance'];

const RECOMMENDED_FLOW: readonly string[] = [
  './brainstem start',
  'connect Claude with the URL it prints',
  './brainstem status',
];

/** Width of the `./brainstem <name>` column across every command, plus a two-space gutter. */
function nameColumnWidth(): number {
  return Math.max(...COMMANDS.map((c) => `./brainstem ${c.name}`.length)) + 2;
}

/**
 * Plain-text help block appended after `--help`: a 3-line "Recommended
 * flow", then each `CommandGroup` as aligned `./brainstem <name>  <summary>`
 * rows with an indented `e.g. <example>` line underneath. This text is the
 * user-facing documentation for every command — keep summaries accurate and
 * short (≤ 70 characters).
 */
export function renderHelpText(): string {
  const width = nameColumnWidth();
  const lines: string[] = ['Recommended flow'];
  for (const step of RECOMMENDED_FLOW) lines.push(`  ${step}`);

  for (const group of GROUPS) {
    lines.push('', group);
    for (const cmd of COMMANDS.filter((c) => c.group === group)) {
      const label = `./brainstem ${cmd.name}`;
      lines.push(`  ${label.padEnd(width)}${cmd.summary}`);
      lines.push(`      e.g. ${cmd.example}`);
    }
  }
  return lines.join('\n');
}
