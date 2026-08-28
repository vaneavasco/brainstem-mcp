import type { ToolAnnotations } from '@modelcontextprotocol/server';

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Replaces content (write, frontmatter update, canvas mutation): destructive but idempotent. */
export const OVERWRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Adds content without removing any: not destructive, not idempotent. */
export const APPEND_ONLY: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const MOVE_OR_DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
