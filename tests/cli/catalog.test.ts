import { describe, expect, it } from 'vitest';
import { COMMANDS, renderHelpText } from '../../src/cli/catalog.ts';

describe('COMMANDS catalog', () => {
  it('every registered commander command has a catalog entry and vice versa', async () => {
    const { buildProgram } = await import('../../src/cli/brainstem.ts');
    const names = buildProgram()
      .commands.map((c) => c.name())
      .filter((n) => n !== 'help');
    expect(new Set(names)).toEqual(new Set(COMMANDS.map((c) => c.name)));
  });

  it('prints the grouped catalog as the ONLY command list', async () => {
    const { buildProgram } = await import('../../src/cli/brainstem.ts');
    const program = buildProgram();
    let text = '';
    program.configureOutput({
      writeOut: (str) => {
        text += str;
      },
    });
    program.outputHelp();
    // commander's built-in "Commands:" block listed every command a second
    // time, right above the grouped catalog — same names, same summaries, no
    // examples, no groups. Each summary must appear exactly once.
    for (const { name, summary } of COMMANDS) {
      expect(text.split(summary).length - 1, name).toBe(1);
    }
    expect(text).not.toMatch(/^Commands:/m);
  });

  it('still prints per-command help for a command with subcommands', async () => {
    const { buildProgram } = await import('../../src/cli/brainstem.ts');
    const secret = buildProgram().commands.find((c) => c.name() === 'secret');
    // `brainstem help secret` must keep listing show/rotate: hiding the
    // top-level list must not cascade into the subcommands' own help.
    const help = secret?.helpInformation() ?? '';
    expect(help).toContain('show');
    expect(help).toContain('rotate');
  });

  it('renderHelpText lists the recommended flow first and groups commands', () => {
    const text = renderHelpText();
    expect(text.indexOf('Recommended flow')).toBeLessThan(text.indexOf('Everyday'));
    for (const g of ['Everyday', 'Configuration', 'Maintenance']) expect(text).toContain(g);
    expect(text).toContain('./brainstem start');
  });
});
