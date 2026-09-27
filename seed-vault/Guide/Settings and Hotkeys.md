---
tags: [guide]
---
# Settings and Hotkeys

**⌘,** opens Settings: theme (dark/light), how new note tabs open
(source, live edit or reading mode), the **Live edit** section (where ⌘E
returns to from reading mode, whether the cursor reveals a construct or
its whole line, whether maths, diagrams and embeds render in place, and
how many rendered blocks stay alive), the **Editor toolbar** section
(when it shows, the selection bubble, which groups and in what order),
editor font size and line
width, daily-note folder/format/template, attachment and templates
folders — and the **hotkey editor**: filter to a command, press **Set**,
type the new chord. Custom bindings are marked, conflicts show in red,
and **Reset** restores the default. The command palette (⌘P) always
shows current bindings.

## This vault

The **This vault** section holds per-vault settings (stored in
`.clew/vault-settings.json`, so they travel with the vault). Among them:

- **Standard Markdown syntax** — disables the jmarkdown inline dialect so
  `*italic*` and `**bold**` behave like everywhere else, while keeping
  math, citations, diagrams, and theorems (renders, exports, live edit
  and the toolbar honor it; source mode's dialect colouring doesn't fully
  adapt yet).
- **jmarkdown project** — for vaults that are jmarkdown manuscripts, it
  re-enables the engine's own-line `[[file.md]]` inclusion, so reading
  mode transcludes chapters exactly the way the CLI build does. The
  trade-off: a wikilink alone on its own line stops being a plain link
  while it's on. Open previews re-render as soon as the box is toggled.
- **Note history**, the **Note API** gate, the **bibliography** file and
  style, **dataviewjs**, and this vault's **TeX fragments** (see
  [[Diagrams]]).
- **Listed but not indexed** and **Hidden entirely** — the two ways to
  tell Clew that part of a folder tree isn't notes. See
  [[Vaults and Files]].

## Default hotkeys

| Chord | Command |
|---|---|
| ⌘O / ⌘P | Quick switcher / command palette |
| ⌘N | New note |
| ⌘E | Toggle reading mode |
| ⌘⇧E | Toggle live edit / source |
| ⌥⇧T | Focus the editor toolbar |
| ⌘↩ | Toggle the task on this line |
| ⌘⇧F / ⌘F | Search vault / search note |
| ⌘⌥← ⌘⌥→ | History back / forward |
| ⌘T ⌘W ⌃Tab | New / close / cycle tabs |
| ⌘\ ⌘⇧\ | Split right / down |
| ⌘⌥B ⌘⌥⇧B | Toggle left / right sidebar |
| ⌘B ⌘I ⌘U | Strong, italic, underline (⌘⇧B intense, ⌘⇧H highlight, ⌘⇧X strike, ⌘⇧C code, ⌘⇧M maths, ⌘⌥↓ ⌘⌥↑ sub/superscript) |
| ⌃\` | Toggle the shell panel (and put the caret in it) |
| ⌘G | Graph view |
| ⌘⇧D | Daily note |
| ⌘⌥T | Insert template |
| ⌘K | Insert wikilink |
| ⌘S | Save note now |
| ⌘, | Settings |

User CSS lives in `.clew/snippets/*.css` — see [[Theming]].
