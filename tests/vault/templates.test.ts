import { describe, expect, it } from 'vitest';
import { renderTemplate, uniquePrefix } from '../../src/vault/templates.ts';

const NOW = new Date('2026-08-30T14:07:00.000Z'); // 17:07 in Europe/Chisinau (UTC+3 in August)
const TZ = 'Europe/Chisinau';

describe('renderTemplate', () => {
  it('resolves title, date and time built-ins with their default formats', () => {
    const { text, unresolved } = renderTemplate('# {{title}}\n\ndate: {{date}}\ntime: {{time}}\n', {
      title: 'My Note',
      now: NOW,
      timezone: TZ,
    });
    expect(text).toBe('# My Note\n\ndate: 2026-08-30\ntime: 17:07\n');
    expect(unresolved).toEqual([]);
  });

  it('formats {{date:FMT}} and {{time:FMT}} with Moment tokens (via the daily-notes converter)', () => {
    const { text } = renderTemplate('{{date:YYYY-MM}} {{time:HH}}', {
      title: 'x',
      now: NOW,
      timezone: TZ,
    });
    expect(text).toBe('2026-08 17');
  });

  it('accepts a format string containing spaces', () => {
    const { text } = renderTemplate('{{date:MMMM d, yyyy}}', {
      title: 'x',
      now: NOW,
      timezone: TZ,
    });
    expect(text).toBe('August 30, 2026');
  });

  it('resolves a custom var and reports the same unresolved name only once', () => {
    const { text, unresolved } = renderTemplate(
      'Hi {{name}}, again {{name}} and {{other}} {{other}}',
      {
        title: 'x',
        now: NOW,
        timezone: TZ,
        vars: { name: 'Vanea' },
      },
    );
    expect(text).toBe('Hi Vanea, again Vanea and {{other}} {{other}}');
    expect(unresolved).toEqual(['other']);
  });

  it('leaves an unknown placeholder verbatim in the text', () => {
    const { text, unresolved } = renderTemplate('{{mystery}}', {
      title: 'x',
      now: NOW,
      timezone: TZ,
    });
    expect(text).toBe('{{mystery}}');
    expect(unresolved).toEqual(['mystery']);
  });

  it('tolerates whitespace inside the braces', () => {
    const { text } = renderTemplate('{{ title }} / {{ date : YYYY }}', {
      title: 'Spaced',
      now: NOW,
      timezone: TZ,
    });
    expect(text).toBe('Spaced / 2026');
  });

  it('supports var names with hyphens and dots', () => {
    const { text, unresolved } = renderTemplate('{{project-id}} {{client.name}}', {
      title: 'x',
      now: NOW,
      timezone: TZ,
      vars: { 'project-id': 'P1', 'client.name': 'Acme' },
    });
    expect(text).toBe('P1 Acme');
    expect(unresolved).toEqual([]);
  });

  it('treats an empty {{date:}}/{{time:}} format as the default format, not an empty string', () => {
    const { text } = renderTemplate('{{date:}} {{time:}}', { title: 'x', now: NOW, timezone: TZ });
    expect(text).toBe('2026-08-30 17:07');
  });

  it('leaves plain text with no placeholders untouched', () => {
    const { text, unresolved } = renderTemplate('no placeholders here\n', {
      title: 'x',
      now: NOW,
      timezone: TZ,
    });
    expect(text).toBe('no placeholders here\n');
    expect(unresolved).toEqual([]);
  });
});

describe('uniquePrefix', () => {
  it('formats YYYYMMDDHHmm plus a trailing space, in the given timezone', () => {
    expect(uniquePrefix(NOW, TZ)).toBe('202608301707 ');
    expect(uniquePrefix(NOW, 'UTC')).toBe('202608301407 ');
  });
});
