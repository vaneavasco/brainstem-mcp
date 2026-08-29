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

  it('renderHelpText lists the recommended flow first and groups commands', () => {
    const text = renderHelpText();
    expect(text.indexOf('Recommended flow')).toBeLessThan(text.indexOf('Everyday'));
    for (const g of ['Everyday', 'Configuration', 'Maintenance']) expect(text).toContain(g);
    expect(text).toContain('./brainstem start');
  });
});
