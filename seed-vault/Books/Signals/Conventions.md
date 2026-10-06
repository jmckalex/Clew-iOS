---
status: revised
Bibliography: ../../Features/refs.bib
Resolve citations: true
Bibliography style: chicago
---
# Conventions

Any pairing of signals with states will do, so long as both players use
the same one. \citet{lewis1969} called such a shared regularity a
/convention/: it is followed because others follow it, and another would
have served as well.

How a population settles on one is a dynamical question. Under the
replicator dynamics a strategy's share $x_i$ grows with its advantage over
the average payoff,

@begin(equation){#eq-replicator}
\dot{x}_i = x_i \left( f_i(x) - \bar{f}(x) \right),
@end(equation)

and in the simplest signalling games almost every starting point leads to
a signalling system \citep{skyrms1996}.

@begin(theorem)[Emergence]{#thm-emergence}
In a two-state, two-signal, two-act game with equiprobable states, the
replicator dynamics carries almost every population to one of the two
signalling systems.
@end(theorem)
