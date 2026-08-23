---
tags: [guide]
---
# Daily Notes and Templates

## The diary

Clew's diary lives in the **Diary** tab of the left sidebar: a month
calendar with a dot on every day that has an entry. Click any day to
open it — or create it — and **⌘⇧D** always opens today. Two storage
modes (Settings → Diary):

- **One note per day** — each day is its own note in the diary folder
  (`Daily/2026-08-22.md` by default). The classic daily-notes shape.
- **Single log note** — every day is a `# date` section of one log
  note, kept newest-first; opening a day jumps straight to (or
  creates) its section, and the whole diary stays one file.

Either way, the **View** buttons compose read-only views rendered by
the full engine: today, this week, this month, everything, or any
interval from the date pickers. Views concatenate the requested days
newest-first; they're generated fresh each time, so edit the days
themselves, not the view.

New entries are seeded from the **template note** when one is set,
with `{{date}}`, `{{time}}`, and `{{title}}` substituted.

## Templates

Notes in the `Templates/` folder can be inserted anywhere with
**⌥⌘T** (or *Insert Template…* in the Format menu), with the same
placeholder substitution.

See also: [[Settings and Hotkeys]], [[Navigation]].
