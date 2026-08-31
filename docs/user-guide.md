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

## Never used Obsidian? The idea in five minutes

Skip this if you already live in Obsidian. If you don't, this is the mental
model that makes everything below click.

**A vault is just a folder of text files.** Every note is a small document —
readable in any app, on any computer, forever. There is no company database
holding your notes hostage: if you stopped using Obsidian tomorrow, the files
would still be there, still readable. That's the foundation everything else
stands on, and it's why Claude editing them is low-risk — they're *files*,
and you can always look at them.

**The magic is links, not folders.** Inside any note you can write
`[[Brief Instagram]]` and it becomes a link to that note. Obsidian also shows
you the reverse — every note that links *to* the one you're reading
("backlinks"). Do this consistently and your notes stop being a pile of
documents and become a web: open a campaign and see every meeting where it
was discussed, every post that belongs to it, every decision that shaped it.
People call this a "second brain" — knowledge that compounds instead of
getting lost in a chat history or a dozen Google Docs.

**A few simple conventions organize everything:**

| Convention | What it looks like | What it's for |
|---|---|---|
| Folders | `Marketing/Campaigns/` | Broad buckets — where a note lives |
| Links | `[[September launch]]` | Relationships — what a note is connected to |
| Tags | `#marketing/q3` | Cross-cutting labels; they nest, so `#marketing` finds all of them |
| Frontmatter | `status: draft`, `budget: 5000` at the top of a note | Structured fields — turns notes into rows you can filter and count |
| Daily notes | one note named `2026-08-31` per day | A landing page for each day: meetings, decisions, loose thoughts |
| Templates | a note full of `{{placeholders}}` | Recurring documents that always come out in the same shape |

Here's a complete campaign note — this is *all* there is to it, a text file:

```markdown
---
status: active
owner: Ana
budget: 5000
channel: [email, social]
tags: [marketing/q3]
---
# September launch

Goal: 500 installs in the first month. Brief: [[Brief Instagram Q3]].

## Actions
- [ ] Approve budget
- [ ] Schedule first three posts
```

**So why does Claude need access?** Because the honest weakness of this whole
system is *discipline*. It works beautifully if every meeting gets filed,
linked and tagged — and in real life, nobody keeps that up. That's the
librarian work Claude takes over: you talk, it files. And because your
structure is machine-readable — links, tags, fields — Claude doesn't just
search text like a dumb search box. It can answer "which active campaigns
are over budget?" (fields), "what's connected to this launch?" (links),
"show me everything Q3" (tags), and when you rename a note it repairs every
link pointing at it. You get the compounding value of a well-kept vault
without having to become the kind of person who keeps one.

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
5. **Ask for tables and links.** "As a table, with a link to each note" turns
   any answer into something you can act on and click through in Obsidian.
6. **Stack requests in one chat.** Each answer builds on the last — find the
   notes, then summarize them, then update their status, without re-explaining.

### Prompts you can copy-paste

Grouped by workflow. Swap the folder names and details for your own.

#### Capturing — get things out of your head and into the vault

> Add to today's daily note, under "Marketing sync": we approved the launch
> budget (5,000 EUR) and the Instagram brief is due Friday. Link the brief.

> Save these raw meeting notes as a new note in Marketing/Meetings, clean them
> up into bullet points, tag them #marketing/q3, and link every campaign
> mentioned. Here are the notes: …

> I'm pasting a chaotic voice-memo transcript. Extract the decisions and the
> action items, add the action items to the "Actions" section of the launch
> campaign note, and file the rest under Marketing/Meetings.

> New idea: a referral program for agencies. Check whether we already have a
> note about referrals; if yes, append this idea there, if not, create one in
> 00-inbox and tag it #idea.

#### Recurring documents — templates do the formatting

> Create a brief for the September launch from my "Campaign Brief" template.
> Channel: Instagram, owner: me, budget: 1,500 EUR. Put it in
> Marketing/Campaigns.

> Make a "Post-mortem" template with sections for goals, results, what worked,
> what didn't, and next time. Then use it to start a post-mortem for the
> August webinar.

> Create my Monday 1:1 agenda from the "1:1" template, dated today, and carry
> over any unchecked items from last week's 1:1 note.

#### Batch work — many notes, one command, all-or-nothing

> Create the content calendar for the September launch as one transaction:
> a teaser post note for Sep 1, a newsletter note for Sep 5, and a case-study
> note for Sep 12 — each in Marketing/Calendar, tagged by channel, linking
> back to the campaign note.

> Mark every note in Marketing/Campaigns with status "draft" and no edits in
> the last 60 days as status "stale" — show me the list before you change
> anything.

> Split this long strategy note into one note per initiative, keep a short
> index note in its place that links to all of them, and do it as a single
> transaction.

#### Finding and remembering — the vault as institutional memory

> Search the vault for everything about pricing decisions, and summarize the
> timeline with a link to each source note.

> What did we agree with the design agency? Check meeting notes from March to
> May and quote the exact lines, with the note each quote comes from.

> Which notes mention "churn" but aren't linked to the Retention project?
> Show me and add the links.

> Find every note that mentions our competitor by name — including notes that
> mention it in passing without linking anywhere — and build a one-page
> "what we know about them" summary.

#### Status boards without a dashboard — your frontmatter is a database

If your notes carry frontmatter fields (status, owner, budget, channel,
due…), Claude can query them like a spreadsheet — filter, sort, group, count:

> Which campaign notes still have status "draft"? Table with note, owner and
> budget, please.

> Group all Marketing/Calendar notes by channel and show the count per
> channel — where are we thin?

> Sum the "budget" field across all active campaigns and list the three
> biggest.

> Show everything with a "due" date in the next 14 days, sorted by date, with
> owner and status.

> Which notes under Clients/ have no "owner" field at all? I want to fill
> those in.

#### Reporting and reviews — the vault writes your update

> List every note modified in the last 7 days under Marketing/, then draft a
> short status update I can paste into Slack.

> It's the end of the month: pull every campaign note touched in August,
> extract results and learnings, and draft a one-page monthly review in
> Marketing/Reviews, linking each campaign.

> Compare the "Mesaje cheie" sections of the last three campaign briefs — are
> we saying the same thing everywhere? Quote the differences.

> Give me the outline of the annual strategy note — just its headings and how
> long each section is — before I decide what to read.

#### Reorganizing — housekeeping without broken links

> Rename "Brief Instagram" to "Brief Instagram Q3" and update everything that
> links to it.

> Move everything about the spring campaign into Marketing/Archive/2026-Spring
> — links should keep working.

> What are my most-used tags? Merge #mktg into #marketing everywhere.

> Run a health check: orphan notes under Marketing/ (nothing links to them,
> they link to nothing), broken links, and ambiguous links — and propose what
> to do with each.

> Delete the three duplicate "Untitled" notes in 00-inbox. (Claude will
> confirm first, and they go to `.trash/`, not into the void.)

#### Visual planning — canvases

> Add a card for the September launch to my "Q3 Plan" canvas and connect it
> to the goals card.

> Build a canvas called "Campaign flow" with the campaign note, its brief and
> the three calendar posts as file cards, arranged left to right, with arrows
> in order.

#### Attachments

> Save this image into Marketing/Assets as logo-v2.png and embed it in the
> brand guidelines note.

### A worked example — launching a campaign in one conversation

The point of a connected vault is that one chat can carry a whole workflow.
This is a realistic sequence, each prompt building on the last:

1. *"Create the note for the September launch campaign in Marketing/Campaigns:
   goal 500 installs in the first month, channels email and social, budget
   5,000 EUR, status draft, tagged #marketing/q3."*
2. *"Now a brief from the Campaign Brief template — channel Instagram, budget
   1,500 — and link it from the campaign note."*
3. *"Create the first three content-calendar entries as one transaction, each
   linking back to the campaign."*
4. *"Add today's meeting outcome to my daily note: budget approved, brief due
   Friday."*
5. *"Set the campaign status to active."*
6. Next Monday, in a fresh chat: *"What's the state of the September launch?
   Backlinks, calendar entries, open action items — and draft my status
   update."*

Nothing from steps 1–5 was lost when the chat ended: Monday's question is
answered from the files, not from the conversation.

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
