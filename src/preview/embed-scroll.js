
// Canvas note embeds scroll their BODY, not the document.
//
// A note on a canvas is this same preview document in an iframe sized to the
// node, and it overflows: measured on Welcome.md in the demo canvas, 2628px
// of content in a 476px frame, touch-action `auto` the whole way up, no inner
// scroller anywhere — the document's own root scroller is the only thing that
// could move. Under a finger it did not move at all, while the very same
// document read in a tab scrolls perfectly. The difference is that a canvas
// node hangs under `.canvas-world`'s scale transform, and WebKit will not
// drive a SUBFRAME'S ROOT scroller by touch from under a transformed
// ancestor. An ordinary element scroller inside a frame is driven fine there
// — the canvas's PDF nodes scroll on exactly that path, which is how this was
// diagnosed — so the cure is to stop asking the root to scroll: `html` goes
// `overflow: hidden`, which stops the viewport inheriting body's overflow,
// and `body` becomes an ordinary scroll container with native momentum.
//
// Only canvas embeds do this, because only they are transformed; the host
// says so (src/shim/ios-ui.js posts on engage) and a note read in a tab is
// untouched. The preview client scrolls with scrollIntoView(), which finds
// whatever container actually scrolls, so scroll-to-line, anchors and
// wikilink jumps keep working either way.
let clewEmbedScrollArmed = false;

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || msg.source !== 'clew-ios' || msg.type !== 'canvas-embed') return;
	if (clewEmbedScrollArmed) return;
	clewEmbedScrollArmed = true;
	const style = document.createElement('style');
	style.id = 'clew-ios-embed-scroll';
	style.textContent = 'html { height: 100%; overflow: hidden; }\n'
		+ 'body { height: 100%; overflow-y: auto; overflow-x: hidden;'
		+ ' -webkit-overflow-scrolling: touch; }';
	(document.head ?? document.documentElement).append(style);
});
