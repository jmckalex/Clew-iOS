---
tags: [guide]
---
# Search

**⌘⇧F** opens full-text search. Results group by note with highlighted
snippets; click one to jump to the match.

Operators compose with plain terms (terms are AND-ed):

- `"exact phrase"` — quoted phrases
- `path:Guide` — only notes whose path contains *Guide*
- `file:demo` — only filenames containing *demo*
- `tag:#guide` — only notes carrying the tag (nested tags match parents)

Example: `theorem tag:#demo path:Features` finds tagged Features notes
mentioning theorems.
