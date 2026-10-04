---
Headings: numeric
Packages: amssymb
---
# Math and Theorems

Numbered display equations with cross-references:

@begin(equation){#eq-euler}
e^{i\pi} + 1 = 0
@end(equation)

@begin(theorem)[Fundamental Triviality]{#thm-main}
Every note in this vault links, directly or indirectly, to [[Welcome]].
@end(theorem)

@begin(lemma){#lem-log}
If $x > 0$ then $\log x$ is defined, and by @ref[eq-euler] nothing
untoward happens.
@end(lemma)

@begin(proof)
Left as an exercise for the vault's reader. $\blacksquare$
@end(proof)

Some inline dialect syntax (TeX-style, like LaTeX): H_2O subscripts,
x^2 and x^{10} superscripts, __underlined__ text, and ==highlighted==
passages.

> [!NOTE]
> GFM alerts render as callout boxes in HTML and tcolorboxes in LaTeX.

## Cross-references @label[sec-xref]

Label anything the engine numbers — `{#key}` on an equation, a theorem or
a figure, or `@label[key]` inside it — and refer to it three ways:
@ref[eq-euler] is the bare number, @cref[thm-main] names its kind, and
@Cref[lem-log] starts a sentence. A heading can be labelled too, when the
note's header says `Headings: numeric` (this one does): this is
@cref[sec-xref].

@begin(figure)[Earthrise, from Apollo 8]{id=fig-earth}
![[NASA - Earthrise.jpg|300]]
@end(figure)

@Cref[fig-earth] is numbered on its own counter. In live edit every
reference shows the number reading mode will print, a click jumps to what
it names, and hovering one previews it. Type `@ref[` for the list of this
note's labels.
