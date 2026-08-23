---
tags: [guide]
---
# Settings and Hotkeys

**⌘,** opens Settings: theme (dark/light), how new note tabs open
(source or reading mode), editor font size and line
width, daily-note folder/format/template, attachment and templates
folders — and the **hotkey editor**: filter to a command, press **Set**,
type the new chord. Custom bindings are marked, conflicts show in red,
and **Reset** restores the default. The command palette (⌘P) always
shows current bindings.

## This vault

The **This vault** section holds per-vault settings (stored in
`.clew/vault-settings.json`). Current options: **Standard
Markdown syntax** — disables the jmarkdown inline dialect so `*italic*`
and `**bold**` behave like everywhere else, while keeping math,
citations, diagrams, and theorems (renders *and* exports honor it; the
editor's dialect highlighting doesn't adapt yet). And **jmarkdown
project** — for vaults that are jmarkdown manuscripts, it re-enables
the engine's own-line `[[file.md]]` inclusion, so reading mode
transcludes chapters exactly the way the CLI build does. The trade-off:
a wikilink alone on its own line stops being a plain link while it's
on. Open previews re-render as soon as the box is toggled.

## Default hotkeys

| Chord | Command |
|---|---|
| ⌘O / ⌘P | Quick switcher / command palette |
| ⌘N | New note |
| ⌘E | Toggle reading mode |
| ⌘⇧F / ⌘F | Search vault / search note |
| ⌘⌥← ⌘⌥→ | History back / forward |
| ⌘T ⌘W ⌃Tab | New / close / cycle tabs |
| ⌘\ ⌘⇧\ | Split right / down |
| ⌘B ⌘⇧B | Toggle left / right sidebar |
| ⌘G | Graph view |
| ⌘⇧D | Daily note |
| ⌘⌥T | Insert template |
| ⌘K | Insert wikilink |
| ⌘S | Save note now |
| ⌘, | Settings |

User CSS lives in `.clew/snippets/*.css` — see [[Theming]].
