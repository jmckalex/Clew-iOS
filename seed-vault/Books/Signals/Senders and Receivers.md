---
status: done
---
# Senders and Receivers

A signalling game has two players. The sender sees the state of the world
and chooses a signal; the receiver sees only the signal and chooses an
act.[fn: The set-up is David Lewis's, from his book on convention.] Both
are paid when the act fits the state.

If there are $n$ equally likely states and each is matched by exactly one
act, the chance that a receiver who ignores the signal acts correctly is

@begin(equation){#eq-chance}
p = \frac{1}{n}.
@end(equation)

A *signalling system* does better: it pairs every state with its own
signal and every signal with the act that fits.

@begin(proposition)[Perfect communication]{#prop-perfect}
In a signalling system the receiver always acts correctly, and neither
player can gain by changing strategy alone.
@end(proposition)

Nothing in the game says WHICH signal goes with which state. That is the
puzzle of the next chapter.
