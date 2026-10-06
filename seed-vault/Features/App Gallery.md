# App Gallery

Six small apps, each a folder under `Apps/` holding a `clew-app.json` and
plain HTML, CSS and JavaScript — no libraries. Each asks for only what it
uses, and Clew asks you, once per app on this device, before it gets any of
it. How apps work, and the whole list of what they can ask for, is in
[[Apps in Notes]].

## Stock Ticker

It is the band along the bottom of this page: a ticker tape, scrolling
right to left as in the films. It is *pinned* there — its embed, at the very
end of this note, says `{pin=bottom}`, so it stays at the bottom edge while
you read above its place and settles into that place when you reach it.
(`pin=top` is the other way round: at the top edge once you have scrolled
past it. Either works in reading view and in Live edit, and only within
its note.)

It has three modes. /Simulated/, the default, needs no network: the
symbols are the table just below and the prices drift by a seeded random
walk from its numbers — invented starting points, not the market, and the
band says SIMULATED. /Live stocks/ shows real US quotes for the same
symbols from Finnhub, each refreshed about once a minute, with the time of
the last update in the band (and "Closed · as of …" when the market is
shut). It needs your own key — free at finnhub.io: choose /Key…/ in the
app, paste it, and it is kept on this device only, in the app's own
storage, never in the vault (so it does not travel with a copy you share);
/Forget key/ removes it. /ECB rates/ shows the euro's reference rates from
the European Central Bank. Which symbols show is your watchlist.

It asks to *read this note* (the table), to *keep a little data of its
own* (the watchlist and the mode) and to *send data to the internet — to
finnhub.io and api.frankfurter.dev, and nowhere else*. Its manifest names
those two hosts and Clew's rules for the app's page let it reach them and
no other; in Simulated mode it asks nothing of either.

| Symbol | Price |
| --- | ---: |
| AAPL | 220.00 |
| MSFT | 410.00 |
| GOOGL | 165.00 |
| AMZN | 185.00 |
| NVDA | 120.00 |
| META | 560.00 |
| TSLA | 250.00 |
| IBM | 215.00 |

## Replicator Dynamics Lab

@app+[Apps/Replicator]{height=780}

The replicator dynamics of a symmetric game: the Stag Hunt, Hawk–Dove, the
Prisoner's Dilemma, Rock–Paper–Scissors, or payoffs of your own. Move a
payoff and the trajectory, the phase line (two strategies) or the simplex
(three) redraw at once; every rest point is found and marked stable,
unstable or neither. /Insert result/ writes a short summary — the game, its
payoffs, the rest points and their stability — at your cursor in this note.

It asks for one thing: to *insert text where you are typing*. It reads
nothing of yours. Open the note in Live edit or Source and put the cursor
where the summary should go.

## Seminar Picker

@app+[Apps/Picker]{height=300}

A wheel of the names below. It remembers who has been picked, so everyone
gets a turn before anyone has a second one; /Reset turns/ starts a new
round, and /Copy name/ puts the name on the clipboard.

It asks to *read this note* (the names), to *keep a little data of its
own* (who has had a turn) and to *copy and paste through Clew* (the
name).

- Ada
- Ben
- Chiara
- Dev
- Elif
- Farid
- Grace
- Hiro

## Writing Progress

@app+[Apps/Progress]{height=210}

This note's word count, counted again every time the note is saved, against
a daily goal. Type a sentence anywhere in this note and watch it move.

It asks to *read this note* (to count it) and to *keep a little data of
its own* (the history and your goal). It hears that the note was saved —
by you, by an app or by another device — and nothing else.

## Reading List

@app+[Apps/ReadingList]{height=340}

Every note in the vault whose properties say `status: to-read` — the four
in `Reading/` to start with — with its author and date; click one to open
it.

It asks to *search this vault and read its index* (to list the notes), to
*read the notes in this vault* (their properties) and to *open notes and
links*. It changes nothing.

## Lecture Timer

@app+[Apps/Timer]{height=280}

A countdown with a progress ring and the lengths a lecture uses — 5, 10, 15
and 50 minutes, or any other. When one runs out it chimes and adds a dated
line to the end of this note — the Lecture log below — through the note's
own editor: ⌘Z takes it back like your own typing.

It asks for one thing: to *edit this note*. It reads nothing of it.

@app+[Apps/Ticker]{height=180 pin=bottom}

## Lecture log

The timer's runs, as it adds them:
