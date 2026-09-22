import { describe, expect, it } from 'vitest';
import { VAULT_PROMPTS } from '../../src/mcp/prompts.ts';
import { startHarness } from '../tools/harness.ts';

function messageText(result: { messages: Array<{ content: unknown }> }): string {
  const content = result.messages[0]?.content as { type: string; text?: string } | undefined;
  return content?.type === 'text' ? (content.text ?? '') : '';
}

describe('MCP prompts (the "+" menu entry points for someone new to Obsidian)', () => {
  it('registers exactly the five prompts, each with a title and description', async () => {
    const h = await startHarness();
    try {
      const { prompts } = await h.client.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual(
        ['capture', 'daily_note', 'get_started', 'tidy_up', 'weekly_review'].sort(),
      );
      for (const prompt of prompts) {
        expect(prompt.title, prompt.name).toBeTruthy();
        expect(prompt.description, prompt.name).toBeTruthy();
      }
    } finally {
      await h.close();
    }
  });

  it('capture renders the given text and mentions vault_append', async () => {
    const h = await startHarness();
    try {
      const result = await h.client.getPrompt({ name: 'capture', arguments: { text: 'hello' } });
      const text = messageText(result);
      expect(text).toContain('hello');
      expect(text).toContain('vault_append');
    } finally {
      await h.close();
    }
  });

  it('daily_note drops the "Entry:" line when entry is absent, and includes it when given', async () => {
    const h = await startHarness();
    try {
      const withoutEntry = messageText(await h.client.getPrompt({ name: 'daily_note' }));
      expect(withoutEntry).not.toContain('Entry:');

      const withEntry = messageText(
        await h.client.getPrompt({ name: 'daily_note', arguments: { entry: 'bought milk' } }),
      );
      expect(withEntry).toContain('Entry:');
      expect(withEntry).toContain('bought milk');
    } finally {
      await h.close();
    }
  });

  it('weekly_review defaults to 7 days and honours an explicit days argument', async () => {
    const h = await startHarness();
    try {
      const defaulted = messageText(await h.client.getPrompt({ name: 'weekly_review' }));
      expect(defaulted).toContain('last 7 days');

      const explicit = messageText(
        await h.client.getPrompt({ name: 'weekly_review', arguments: { days: '30' } }),
      );
      expect(explicit).toContain('last 30 days');

      // A blank optional field in a client form arrives as '' (arguments are strings only).
      const blank = messageText(
        await h.client.getPrompt({ name: 'weekly_review', arguments: { days: '' } }),
      );
      expect(blank).toContain('last 7 days');
    } finally {
      await h.close();
    }
  });

  it('every vault_*/brainstem_* name mentioned in a prompt text is a tool actually registered', async () => {
    const h = await startHarness();
    try {
      const { tools } = await h.client.listTools();
      const registered = new Set([
        ...tools.map((t) => t.name),
        'brainstem_ping',
        'brainstem_guide',
      ]);
      for (const prompt of VAULT_PROMPTS) {
        const dummyArgs = Object.fromEntries(prompt.args.map((a) => [a.name, 'dummy']));
        const rendered = prompt.text(dummyArgs);
        const mentioned = [...new Set(rendered.match(/\b(?:vault|brainstem)_[a-z_]+/g) ?? [])];
        for (const name of mentioned) expect(registered, `${prompt.name}: ${name}`).toContain(name);
      }
    } finally {
      await h.close();
    }
  });

  it('read-only mode registers only the read-only prompts (get_started, weekly_review)', async () => {
    const h = await startHarness(undefined, null, undefined, undefined, true);
    try {
      const { prompts } = await h.client.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual(['get_started', 'weekly_review']);
      await expect(
        h.client.getPrompt({ name: 'capture', arguments: { text: 'x' } }),
      ).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
});
