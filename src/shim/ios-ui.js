// iOS touch adaptations layered over the unmodified renderer. Kept small
// and additive: anything structural belongs upstream behind a capability
// check, not here.

// ---- long-press → contextmenu ---------------------------------------------
// Five surfaces put rename/delete/pin/canvas-styling exclusively behind
// right-click (see PORT-PLAN). WebKit on iOS does not fire contextmenu for
// long-press, so synthesize one: press-and-hold 500ms without moving 10px.
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

let press = null;

document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'touch') return;
	press = {
		x: e.clientX, y: e.clientY, target: e.target,
		timer: setTimeout(() => {
			const { x, y, target } = press ?? {};
			press = null;
			target?.dispatchEvent(new MouseEvent('contextmenu', {
				bubbles: true, cancelable: true, clientX: x, clientY: y,
			}));
			// Suppress the click that would follow the release.
			suppressNextClick = true;
		}, LONG_PRESS_MS),
	};
}, true);

let suppressNextClick = false;
const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
document.addEventListener('pointermove', (e) => {
	if (!press) return;
	if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
}, true);
document.addEventListener('pointerup', cancelPress, true);
document.addEventListener('pointercancel', cancelPress, true);
document.addEventListener('click', (e) => {
	if (suppressNextClick) {
		suppressNextClick = false;
		e.stopPropagation();
		e.preventDefault();
	}
}, true);

// ---- device class on <body> for ios.css ----------------------------------
document.body.classList.add('is-ios');
if (matchMedia('(max-width: 700px)').matches) document.body.classList.add('is-compact');
