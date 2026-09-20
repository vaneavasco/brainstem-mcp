import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';

const EXPECTED = [
  'vault_read',
  'vault_batch_read',
  'vault_write',
  'vault_write_binary',
  'vault_edit',
  'vault_append',
  'vault_frontmatter_update',
  'vault_batch_frontmatter_update',
  'vault_search',
  'vault_search_frontmatter',
  'vault_list',
  'vault_move',
  'vault_delete',
  'vault_canvas_read',
  'vault_canvas_add_node',
  'vault_canvas_add_edge',
  'vault_canvas_update_node',
  'vault_canvas_remove',
  'vault_daily_note_path',
  'vault_daily_note_read',
  'vault_daily_note_append',
  'vault_analytics_summary',
  'vault_analytics_findings',
  'vault_links',
  'vault_tags',
  'vault_outline',
  'vault_transaction',
  'vault_query',
  'vault_recent',
  'vault_create_from_template',
];

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('tool surface parity', () => {
  it('points a model that never saw the connection instructions at brainstem_guide from the entry tools', async () => {
    const { tools } = await h.client.listTools();
    for (const name of ['vault_list', 'vault_search', 'vault_query', 'vault_read']) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain('brainstem_guide');
    }
  });

  it("output schemas stay open to new fields: a client that cached yesterday's tool list must not reject tomorrow's result", async () => {
    const { tools } = await h.client.listTools();
    const closed: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.type === 'object' && o.additionalProperties === false) closed.push(where);
      for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`);
    };
    for (const tool of tools) if (tool.outputSchema) walk(tool.outputSchema, tool.name);
    expect(closed).toEqual([]);
  });

  it('input schemas are closed at every level: an argument nobody declared is refused', async () => {
    const { tools } = await h.client.listTools();
    // JSON Canvas is extensible by design: a canvas node, edge or patch may carry properties this
    // server does not know, and they are written through. Everything else names its keys.
    const OPEN_BY_DESIGN =
      /^vault_canvas_(add_node|add_edge|update_node)\.properties\.(node|edge|patch)/;
    const open: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      const named = o.properties && Object.keys(o.properties as object).length > 0;
      if (named && o.additionalProperties !== false && !OPEN_BY_DESIGN.test(where))
        open.push(where);
      for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`);
    };
    for (const tool of tools) walk(tool.inputSchema, tool.name);
    expect(open).toEqual([]);
  });

  it('exposes exactly the 30 vault tools plus brainstem_ping and brainstem_guide, each with title, description and full annotations', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...EXPECTED, 'brainstem_guide', 'brainstem_ping'].sort(),
    );
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
      expect(tool.description?.length ?? 0, tool.name).toBeLessThan(600);
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(
          typeof (tool.annotations as Record<string, unknown>)[key],
          `${tool.name}.${key}`,
        ).toBe('boolean');
      }
    }
    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual([
      'brainstem_guide',
      'brainstem_ping',
      'vault_analytics_findings',
      'vault_analytics_summary',
      'vault_batch_read',
      'vault_canvas_read',
      'vault_daily_note_path',
      'vault_daily_note_read',
      'vault_links',
      'vault_list',
      'vault_outline',
      'vault_query',
      'vault_read',
      'vault_recent',
      'vault_search',
      'vault_search_frontmatter',
      'vault_tags',
    ]);
  });

  it('is deterministic across two listings (prompt-cache friendly)', async () => {
    const a = await h.client.listTools();
    const b = await h.client.listTools();
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
  });
});
