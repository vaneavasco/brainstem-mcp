# Using your vault from Claude — a guide for the non-technical

This is for the person who *uses* brainstem — a manager, a marketer, anyone who
lives in notes and meetings — not the person who installed it. No terminal
needed past the first connection. If you want the setup side instead, that's
the [README](../README.md).

## What this actually is, in three sentences

Your notes live in [Obsidian](https://obsidian.md): plain files, in a folder,
on a computer you control. brainstem gives Claude hands — it lets Claude read,
search, create and edit those files, with guardrails. Nothing is copied into
some new database: everything Claude writes appears in Obsidian the moment
it's written, as a normal note you can open and edit yourself.

Two honest limits before anything else:

- **It works with Claude only** — claude.ai in the browser, the Claude mobile
  and desktop apps, and Claude Code. ChatGPT cannot connect to it (a
  deliberate design decision, not a bug — the server only trusts Claude's
  sign-in mechanism).
- **One server, one vault, one owner.** brainstem is single-user by design.
  A whole team means each person runs their own copy against their own vault —
  it is not a shared workspace with accounts and permissions.

## Why you'd want this

Without brainstem, Claude is a brilliant colleague with amnesia: every chat
starts from zero, and everything it writes for you dies in the chat window.
Connected to your vault, the same conversations *accumulate*:

- **Meeting notes that file themselves.** Dictate or paste raw notes; Claude
  writes them into today's daily note, tags them, and links them to the
  project they belong to.
- **Briefs and recurring documents from your templates.** One sentence from
  you, and a campaign brief appears — with the date, owner, budget and channel
  filled in, in the right folder, following *your* template.
- **A content calendar created in one go.** Ten post drafts as ten linked
  notes, created as a single all-or-nothing batch.
- **Institutional memory you can question.** "What did we decide about pricing
  in June?" becomes a real search across everything you've ever noted, with
  links to the sources.
- **Reorganizing without breakage.** Rename or move a note and every link
  pointing at it is rewritten — same as Obsidian itself would.
- **A weekly status in seconds.** "What changed under Marketing/ this week?"
  is one question, answered from file history, not from memory.

## Connecting (you do this once per device)

Ask whoever set up brainstem for two things: the **URL** and the **owner
secret** (a password). Then:

- **claude.ai (web or mobile):** Settings → Connectors → *Add custom
  connector* → paste `<the URL>/mcp` → Connect → type the owner secret →
  Approve.
- **Claude Desktop:** same flow, in Settings → Connectors.

That's it. The secret is asked for once per app; afterwards Claude reconnects
on its own. If Claude suddenly asks you to reconnect out of the blue, the
server's URL probably changed — ask your admin (see
"[Quick tunnel caveat](../README.md#quick-tunnel-caveat)").

## How to ask for things

You don't need special syntax — you're talking to Claude, and Claude figures
out which vault operation fits. What helps:

1. **Name folders and notes when you know them.** "…in Marketing/Campaigns"
   beats "…somewhere in my notes".
2. **Ask it to look before it creates.** "Check whether a note about X already
   exists first" avoids duplicates.
3. **For bulk changes, ask for a plan first.** "Show me what you'd change
   before touching anything" — Claude can preview edits as a diff and batch
   related changes so they all land or none do.
4. **Mention your template by name** when you want one used.

### Prompts you can copy-paste

Capture and daily work:

> Add to today's daily note, under "Marketing sync": we approved the launch
> budget (5,000 EUR) and the Instagram brief is due Friday. Link the brief.

> Save these raw meeting notes as a new note in Marketing/Meetings, clean them
> up into bullet points, tag them #marketing/q3, and link every campaign
> mentioned.

Documents from templates:

> Create a brief for the September launch from my "Campaign Brief" template.
> Channel: Instagram, owner: me, budget: 1,500 EUR. Put it in
> Marketing/Campaigns.

Batch work:

> Create the content calendar for the September launch as one transaction:
> a teaser post note for Sep 1, a newsletter note for Sep 5, and a case-study
> note for Sep 12 — each in Marketing/Calendar, tagged by channel, linking
> back to the campaign note.

Finding and deciding:

> Search the vault for everything about pricing decisions, and summarize the
> timeline with a link to each source note.

> Which notes mention "churn" but aren't linked to the Retention project?
> Show me and add the links.

Reporting:

> List every note modified in the last 7 days under Marketing/, then draft a
> short status update I can paste into Slack.

> Which campaign notes still have status "draft"? Table with note, owner and
> budget, please.

Housekeeping:

> Rename "Brief Instagram" to "Brief Instagram Q3" and update everything that
> links to it.

> What are my most-used tags? Any orphan notes under Marketing/ that link to
> nothing and nothing links to?

Visual planning:

> Add a card for the September launch to my "Q3 Plan" canvas and connect it
> to the goals card.

## The safety net (why you can let it write)

- **Nothing is ever erased.** "Delete" moves a note to a `.trash/` folder
  inside the vault, and Claude must explicitly confirm a delete before the
  server accepts it. You can always fish anything back out.
- **No silent overwrites.** If you edit a note in Obsidian while Claude is
  working on the same note, Claude's stale write is rejected and it re-reads
  before retrying — the server enforces this; it's not model politeness.
- **Everything is inspectable.** Every change is a plain file you can open,
  diff and version like any other. If your vault syncs (Obsidian Sync,
  Syncthing, iCloud…), Claude's edits ride along like your own.
- **Size and scope limits are enforced server-side** — notes cap at 1 MB,
  searches and listings are bounded, and the server's own private folder
  (`_brainstem/`) is invisible to every operation.

## What it will not do

- Read other people's vaults, your email, or anything outside the one folder
  it was pointed at.
- Work from ChatGPT, Gemini, or other assistants (Claude-only, see above).
- Act as a shared team drive — one instance serves one person's vault.
- Sync your vault between machines (that stays the job of whatever sync tool
  you already use).

## If something feels off

| Symptom | Likely cause / fix |
|---|---|
| Claude says it can't reach the connector | The server or tunnel is down — ask your admin to run `./brainstem status`. |
| Claude asks you to reconnect and approve again | The server's URL rotated (quick-tunnel mode). Reconnect with the new URL; ask your admin about a stable URL. |
| Claude reports a "CONFLICT" on an edit | Someone (probably you, in Obsidian) changed the note mid-edit. Just tell Claude to re-read and retry — that's the designed flow. |
| A note "disappeared" | Look in the vault's `.trash/` folder — deletes are never permanent. |

One more lever worth knowing: the file `_brainstem/instructions.md` inside the
vault is read by Claude on every connection. Your admin (or you, in Obsidian)
can write your team's conventions there — folder layout, naming rules,
required frontmatter — and Claude will follow them without being told in
every chat.
