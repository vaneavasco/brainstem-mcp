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
  it('exposes exactly the 30 vault tools plus brainstem_ping, each with title, description and full annotations', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED, 'brainstem_ping'].sort());
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
