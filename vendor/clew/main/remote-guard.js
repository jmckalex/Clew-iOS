// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which network addresses Clew's remote-PDF fetcher may connect to
// (docs/dev/pdf-unification.md §4). A note names a URL; Clew fetches it; so
// a note must not be able to point Clew at the machine's own services, the
// local network or a cloud metadata endpoint. Every address a host resolves
// to is checked here, and the connection is then pinned to one that passed
// (remote-fetch.js), so a second DNS answer cannot slip in between.
//
// Refused: loopback, "this network", private and shared (CGNAT) space,
// link-local (169.254/16 — the metadata address among them), multicast,
// reserved and broadcast, the documentation and benchmarking ranges, and in
// IPv6 the unspecified and loopback addresses, unique-local, link- and
// site-local, multicast, discard and documentation prefixes — plus every
// IPv6 form that CARRIES an IPv4 address (mapped, compatible, NAT64, 6to4),
// judged by the IPv4 inside it, and Teredo outright.
//
// Pure: no DNS, no sockets — tests/remote-guard.test.js exercises it all.
import net from 'node:net';

const V4_REFUSED = [
	['0.0.0.0', 8],          // "this network"
	['10.0.0.0', 8],         // private
	['100.64.0.0', 10],      // shared address space (CGNAT)
	['127.0.0.0', 8],        // loopback
	['169.254.0.0', 16],     // link-local, cloud metadata (169.254.169.254)
	['172.16.0.0', 12],      // private
	['192.0.0.0', 24],       // IETF protocol assignments
	['192.0.2.0', 24],       // documentation (TEST-NET-1)
	['192.88.99.0', 24],     // 6to4 relay anycast (deprecated)
	['192.168.0.0', 16],     // private
	['198.18.0.0', 15],      // benchmarking
	['198.51.100.0', 24],    // documentation (TEST-NET-2)
	['203.0.113.0', 24],     // documentation (TEST-NET-3)
	['224.0.0.0', 4],        // multicast
	['240.0.0.0', 4],        // reserved, and 255.255.255.255 broadcast
];

const V6_REFUSED = [
	['::', 128],             // unspecified
	['::1', 128],            // loopback
	['100::', 64],           // discard-only
	['2001:db8::', 32],      // documentation
	['fc00::', 7],           // unique local
	['fe80::', 10],          // link-local
	['fec0::', 10],          // site-local (deprecated)
	['ff00::', 8],           // multicast
];

function v4ToInt(address) {
	return address.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function v4InRange(address, [base, bits]) {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (v4ToInt(address) & mask) === (v4ToInt(base) & mask);
}

/** Expand an IPv6 address (with an optional dotted-quad tail) to 8 words. */
function v6Words(address) {
	let text = address.toLowerCase().replace(/%.*$/, '');
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (tail) {
		const n = v4ToInt(tail[1]);
		text = text.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
	}
	const [head, rest] = text.split('::');
	const left = head ? head.split(':') : [];
	const right = rest !== undefined && rest !== '' ? rest.split(':') : [];
	const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill('0');
	return [...left, ...fill, ...right].map((w) => parseInt(w || '0', 16));
}

function v6InRange(words, [base, bits]) {
	const baseWords = v6Words(base);
	for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
		const take = Math.min(16, bits);
		const mask = (0xffff << (16 - take)) & 0xffff;
		if ((words[i] & mask) !== (baseWords[i] & mask)) return false;
	}
	return true;
}

const wordsToV4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * Why `address` (an IP literal, v4 or v6) may not be connected to, or null
 * when it may. The reason is for the refusal the viewer shows.
 */
export function refusedAddress(address) {
	const kind = net.isIP(String(address).replace(/%.*$/, ''));
	if (kind === 4) {
		return V4_REFUSED.some((range) => v4InRange(address, range))
			? `${address} is a local, private or reserved address` : null;
	}
	if (kind !== 6) return `${address} is not an IP address`;
	const w = v6Words(address);
	if (V6_REFUSED.some((range) => v6InRange(w, range))) return `${address} is a local, private or reserved address`;
	// Forms that carry an IPv4 address are judged by it.
	const embedded =
		(w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) ? wordsToV4(w[6], w[7])      // ::ffff:a.b.c.d mapped
		: (w.slice(0, 6).every((x) => x === 0)) ? wordsToV4(w[6], w[7])                       // ::a.b.c.d compatible
		: (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) ? wordsToV4(w[6], w[7]) // 64:ff9b::/96 NAT64
		: (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) ? wordsToV4(w[6], w[7])            // 64:ff9b:1::/48 local NAT64
		: (w[0] === 0x2002) ? wordsToV4(w[1], w[2])                                             // 2002::/16 6to4
		: null;
	if (embedded) {
		const inner = refusedAddress(embedded);
		return inner ? `${address} carries ${embedded}, a local, private or reserved address` : null;
	}
	// Teredo hides its IPv4 (obfuscated); no reason for a PDF host to use it.
	if (w[0] === 0x2001 && w[1] === 0) return `${address} is a Teredo tunnel address`;
	return null;
}

/**
 * The resolved answers for one host, vetted: every one must pass, or the
 * host is refused whole — a name that resolves to a public AND a private
 * address is one an attacker controls. Returns the address to pin, or
 * throws a RemoteError('refused-address').
 */
export function vetAddresses(host, answers, RemoteError) {
	if (!answers?.length) throw new RemoteError('dns', `${host} did not resolve`);
	for (const { address } of answers) {
		const why = refusedAddress(address);
		if (why) throw new RemoteError('refused-address', `${host}: ${why}`);
	}
	return answers[0];
}
