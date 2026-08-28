import { createTwoFilesPatch } from 'diff';
import { type TextPatch, VaultError } from './types.ts';

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    // Advance by 1 to detect overlapping matches; they count as separate ambiguities
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

export function applyTextPatches(
  content: string,
  patches: TextPatch[],
): { content: string; applied: number } {
  if (patches.length === 0) {
    throw new VaultError('INVALID_INPUT', 'At least one patch is required.');
  }
  let current = content;
  patches.forEach((patch, i) => {
    if (patch.find.length === 0) {
      throw new VaultError('INVALID_INPUT', `patch #${i + 1}: "find" must not be empty.`);
    }
    const occurrences = countOccurrences(current, patch.find);
    if (occurrences !== 1) {
      throw new VaultError(
        'INVALID_INPUT',
        `patch #${i + 1}: "find" text occurs ${occurrences} times; it must occur exactly once. Include more surrounding context to disambiguate.`,
      );
    }
    current = current.replace(patch.find, () => patch.replace);
  });
  return { content: current, applied: patches.length };
}

export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, {
    context: 3,
  });
}
