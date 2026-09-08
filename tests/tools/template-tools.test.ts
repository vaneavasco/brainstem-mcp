import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness({ dailyNotes: { timezone: 'Europe/Chisinau' } });
});

afterEach(async () => {
  await h.close();
});

describe('vault_create_from_template', () => {
  it('renders title/date/time/vars and creates the note', async () => {
    await h.call('vault_write', {
      path: 'templates/meeting.md',
      content: '---\ntype: meeting\n---\n# {{title}}\n\nDate: {{date}}\nAttendee: {{attendee}}\n',
    });
    const result = await h.call('vault_create_from_template', {
      templatePath: 'templates/meeting.md',
      targetPath: '00-inbox/Standup.md',
      vars: { attendee: 'Vanea' },
    });
    expect(result.structuredContent).toMatchObject({
      path: '00-inbox/Standup.md',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      unresolved: [],
    });
    const read = await h.call('vault_read', { path: '00-inbox/Standup.md' });
    expect(text(read)).toContain('# Standup');
    expect(text(read)).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
    expect(text(read)).toContain('Attendee: Vanea');
  });

  it('defaults the title to the target basename without .md', async () => {
    await h.call('vault_write', { path: 'templates/t.md', content: '# {{title}}\n' });
    await h.call('vault_create_from_template', {
      templatePath: 'templates/t.md',
      targetPath: '00-inbox/My Idea.md',
    });
    const read = await h.call('vault_read', { path: '00-inbox/My Idea.md' });
    expect(text(read)).toBe('# My Idea\n');
  });

  it('an explicit title overrides the default', async () => {
    await h.call('vault_write', { path: 'templates/t.md', content: '# {{title}}\n' });
    await h.call('vault_create_from_template', {
      templatePath: 'templates/t.md',
      targetPath: '00-inbox/x.md',
      title: 'Custom Title',
    });
    const read = await h.call('vault_read', { path: '00-inbox/x.md' });
    expect(text(read)).toBe('# Custom Title\n');
  });

  it('fails ALREADY_EXISTS and never overwrites the existing target', async () => {
    await h.call('vault_write', { path: 'templates/t.md', content: '# {{title}}\n' });
    await h.call('vault_write', { path: '00-inbox/exists.md', content: 'original\n' });
    const result = await h.call('vault_create_from_template', {
      templatePath: 'templates/t.md',
      targetPath: '00-inbox/exists.md',
    });
    expect(text(result)).toMatch(/ALREADY_EXISTS/);
    const read = await h.call('vault_read', { path: '00-inbox/exists.md' });
    expect(text(read)).toBe('original\n');
  });

  it('fails NOT_FOUND when the template does not exist', async () => {
    const result = await h.call('vault_create_from_template', {
      templatePath: 'templates/missing.md',
      targetPath: '00-inbox/x.md',
    });
    expect(text(result)).toMatch(/NOT_FOUND/);
  });

  it('uniquePrefix prepends "YYYYMMDDHHmm " (vault timezone) to the target basename', async () => {
    await h.call('vault_write', { path: 'templates/t.md', content: '# {{title}}\n' });
    const result = await h.call('vault_create_from_template', {
      templatePath: 'templates/t.md',
      targetPath: '00-inbox/Note.md',
      uniquePrefix: true,
    });
    const path = (result.structuredContent as { path: string }).path;
    expect(path).toMatch(/^00-inbox\/\d{12} Note\.md$/);
    const read = await h.call('vault_read', { path });
    // The default title comes from the target basename *before* the prefix was applied.
    expect(text(read)).toBe('# Note\n');
  });

  it('reports unresolved placeholders without failing, leaving them verbatim', async () => {
    await h.call('vault_write', { path: 'templates/t.md', content: '{{title}} {{unknownVar}}\n' });
    const result = await h.call('vault_create_from_template', {
      templatePath: 'templates/t.md',
      targetPath: '00-inbox/y.md',
    });
    expect(result.structuredContent).toMatchObject({ unresolved: ['unknownVar'] });
    const read = await h.call('vault_read', { path: '00-inbox/y.md' });
    expect(text(read)).toBe('y {{unknownVar}}\n');
  });
});

describe('vault_create_from_template refuses a rendered note whose frontmatter is invalid YAML', () => {
  it('fails INVALID_INPUT, names the problem and creates nothing', async () => {
    await h.call('vault_write', {
      path: 'templates/person.md',
      content:
        '---\ntype: person\nname: "{{title}}"\norganization: "{{organization}}"\n---\n# {{title}}\n',
    });
    const result = await h.call('vault_create_from_template', {
      templatePath: 'templates/person.md',
      targetPath: 'People/Broken.md',
      vars: { organization: '""' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/INVALID_INPUT/);
    expect(text(result)).toMatch(/not valid YAML/);
    const read = await h.call('vault_read', { path: 'People/Broken.md' });
    expect(text(read)).toMatch(/NOT_FOUND/);
  });

  it('still creates notes whose rendered frontmatter is valid', async () => {
    await h.call('vault_write', {
      path: 'templates/person2.md',
      content: '---\ntype: person\norganization: "{{organization}}"\n---\n# {{title}}\n',
    });
    const result = await h.call('vault_create_from_template', {
      templatePath: 'templates/person2.md',
      targetPath: 'People/Fine.md',
      vars: { organization: '' },
    });
    expect(result.isError).toBeFalsy();
    const read = await h.call('vault_read', { path: 'People/Fine.md' });
    expect(read.structuredContent).toMatchObject({
      frontmatter: { type: 'person', organization: '' },
    });
  });
});
