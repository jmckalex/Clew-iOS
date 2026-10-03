---
tags: [guide]
---
# Apps in Notes

A note can hold a small **app** — a timer, a flashcard drill, a form —
written as ordinary HTML and JavaScript in a folder of the vault, and
embedded with one line:

@app+[Apps/Flashcards]{height=300}

That is a real app: it reads the questions and answers at the bottom of
this note, and keeps its best score.

## The embed

`@app[Apps/Flashcards]` inline, `@app+[Apps/Flashcards]` as a block, or
`@begin(app)` … `@end(app)`. Options: `width`, `height` (a bare number is
pixels; the default box is the note's width and 320px tall), `aspect`
(quote it: `aspect="16/9"`), `style` and `class`. Clew says so in the note,
by name, when the target is not a folder, has no `clew-app.json`, has a
manifest it cannot read, climbs out of the vault, or is a URL (remote apps
are not supported yet).

## The app

A folder holding `clew-app.json` and the app's files:

```json
{
	"id": "flashcards",
	"name": "Flashcards",
	"version": "1.0.0",
	"entry": "index.html",
	"capabilities": ["note.read", "app.kv"]
}
```

The `id` is what the app IS: move or rename its folder and it is the same
app, with its permissions and its stored data. Two folders in one vault with
the same id are both refused — give a copy a new id.

## What an app can do

An app runs on **an origin of its own**, apart from Clew and from the vault:
it can read its own folder like any web page, and nothing else, until you
allow more. It reaches Clew through `window.clew`, which Clew injects:

- `clew.context()` — the note it sits in, the vault, the theme. Always.
- **note.read** — `clew.notes.read()` and `clew.properties.get()` of *this*
  note. **notes.read** — the same for any note or text file in the vault.
- **query** — `clew.notes.list()`, `clew.search(q)`, `clew.index.get(path)`,
  `clew.index.backlinks(path)`.
- **app.kv** — `clew.kv.get/set/delete/list`, a little data of its own in
  the vault's `clewdata.json` (it travels with the vault).
- **app.files** — `clew.files.list/read/write/delete/mkdir` in its own
  `data/` folder (25 MB a file, 250 MB an app; no notes, no hidden names).
- **links.open** — `clew.open('Some Note')`, or an http(s) link in your
  browser.
- **network** — by default an app cannot send anything anywhere: no fetch,
  no form, not even an image from another host. Asking for `network` (or
  `"network": ["https://api.example.com"]` for named hosts only) lifts that.
- **note.write** — `clew.notes.write(null, text)`, `clew.notes.append(null,
  text)`, `clew.properties.set(…)` on *this* note, through its editor: ⌘Z
  takes an app's edit back like your own. **notes.write** — the same on any
  note. **notes.create** — a new note, never over an existing one.
  **editor.insert** — at your cursor. **find** and **clipboard** too.

`await clew.ready` tells the app what it was granted; `clew.can('app.kv')`
asks about one. `clew.on('note-changed', …)` hears when this note is saved
(with **note.read** — the cards below follow it), and `clew.on(
'grant-changed', …)` when you allow more, while the app keeps running.

## The prompt

The first time an app appears, Clew asks — in its own window, never inside
the note — "Flashcards is an app in this vault. It wants to read this note
and keep a little data of its own." **Allow** or **Don't allow**, once per
app per vault, on this device: nothing is stored in the vault, so a vault
you send someone arrives asking nothing. An app that later asks for more
asks again, for the new things only.

In a vault you have **not trusted** (see the trust prompt), an app still
works — that is the point of running it apart — but it does not even start
until you answer, and the prompt says the vault is untrusted. Its code is
the only code of that vault that runs.

Settings → *This vault* → *Apps* lists every app the vault carries, what it
may do and which notes it is open in now; **Revoke** forgets the app here,
so it asks again. While an app allowed to change notes is open, the status
bar says so — "✎ Writer can edit notes" — and a click goes to that list.

## Cards

Q: What does an app run on?
A: An origin of its own — clew-frame://, apart from Clew and the vault.

Q: Where are an app's permissions kept?
A: On this device, never in the vault.

Q: What keeps an app the same app when its folder moves?
A: Its id in clew-app.json.

Q: What can an app send to the internet by default?
A: Nothing, until it is allowed "network".
