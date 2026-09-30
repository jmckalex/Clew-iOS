---
tags: [guide]
---
# Tabbing

LaTeX's `tabbing` environment: text lined up at **stops** you set as you
go, the way a typewriter's tab stops work. Write a ```` ```tabbing ````
fence; every line is a row, and a bar plus one character is a tab command.

```tabbing
Alice $\qquad$ |= 12 Oak Street $\qquad$ |= |kill
Name:       |> Street:          |> Phone
Alice       |> 12 Oak Street    |> 555 1234
Bob         |> 7 Elm Road       |> 555 9876
```

````markdown
```tabbing
Alice $\qquad$ |= 12 Oak Street $\qquad$ |= |kill
Name:       |> Street:          |> Phone
Alice       |> 12 Oak Street    |> 555 1234
Bob         |> 7 Elm Road       |> 555 9876
```
````

`|=` sets a stop where it stands — right after the text before it,
measured as it is drawn — and `|>` moves to the next one. So the first row
here is a **ruler**: it ends in `|kill`, which sets its stops without
showing it, and it holds each column's WIDEST entry, so every row fits
(the `$\qquad$` adds a gutter, as `\qquad` does in LaTeX). Stops set from
the short header words instead would make the longer entries run under the
next column. The spaces in the source are only there to keep it readable;
a run of them counts as one.

## A ruler row

A ruler is any row ending in `|kill` — it can hold placeholder text, or
columns wider than anything in the table:

```tabbing
Wednesday:   |= 10:00–11:00   |= Lecture hall |kill
Mon          |> 9:00          |> Seminar
Tue          |> 14:00         |> Lab
```

## Indenting, and stepping back

`|+` moves the left margin in by one stop for the rows that follow, `|-`
moves it back, and `|<` at the start of a row steps back one stop for that
row only — handy for pseudo-code:

```tabbing
while |= xxxx |= |kill
while there is work |+
take the next item
if it is done |+
drop it
|< else
put it back |-|-
end
```

Here `|<` puts `else` level with its `if`, one stop out from the rows
around it, and the two `|-` on the last indented row bring `end` home.

## Flush right

`|'` puts the text so far flush right, just before the column it is in —
labels hanging in the margin — and `` |` `` puts the rest of the row
against the right edge:

```tabbing
Label: |= The text starts here |kill
|> Item |' The item's text lines up at the column
|> Longer item |' So does this one
A title |` page 7
```

## Saving the stops

`|[` and `|]`, each alone on a row, save and restore the stops, so a few
rows can have columns of their own:

```tabbing
Left |= Middle |= Right
|[
A much longer first column |= x |kill
|> in the temporary column
|]
|> back in the middle
```

## LaTeX, as written

LaTeX's own commands work too — `\=`, `\>`, `\<`, `\+`, `\-`, `\'`, `` \` ``,
`\\`, `\kill`, `\pushtabs`, `\poptabs` — inside the fence or as a
`@begin(tabbing)` environment, so tabbing pasted from a `.tex` file needs no
rewriting. Since `\=`, `\'` and `` \` `` are taken, the accents they usually
write are `\a=`, `\a'` and `` \a` ``. Cells carry any inline formatting,
and maths:

@begin(tabbing)
*Symbol* \= $x^2 + y^2$ \= /the circle/ \\
*Name* \> $r$ \> radius \\
Caf\a'e \> $\bar{x}$ \> the m\a=ean
@end(tabbing)

A cell wider than its column runs on under the next one, as it does in
LaTeX — tabbing is for text you know will fit. Live edit shows the result
in place of the source while the cursor is elsewhere, and the source is
highlighted so the tab commands stand out from the text.
