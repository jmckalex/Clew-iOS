// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Minimal EXIF reader for photo maps: GPS coordinates (and the capture
// time when present) out of a JPEG, nothing else. Hand-rolled — the format
// is a stable TIFF container and we need exactly four GPS tags. Pure
// buffer-in, object-out; unit-tested against generated fixtures.
//
// Returns { lat, long, time? } (decimal degrees; time as 'YYYY:MM:DD
// HH:MM:SS' verbatim from the file) or null when the JPEG carries no GPS.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export function exifGps(buffer) {
	try {
		return parse(buffer);
	} catch {
		return null; // truncated / malformed EXIF is a "no GPS", never a crash
	}
}

function parse(buffer) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

	// Walk JPEG segments to APP1/Exif.
	let offset = 2;
	let tiff = -1;
	while (offset + 4 <= view.byteLength) {
		const marker = view.getUint16(offset);
		if ((marker & 0xff00) !== 0xff00) break;
		const size = view.getUint16(offset + 2);
		if (marker === 0xffe1
			&& view.getUint32(offset + 4) === 0x45786966 // 'Exif'
			&& view.getUint16(offset + 8) === 0x0000) {
			tiff = offset + 10;
			break;
		}
		if (marker === 0xffda) break; // start of scan — no EXIF ahead
		offset += 2 + size;
	}
	if (tiff < 0) return null;

	const order = view.getUint16(tiff);
	const little = order === 0x4949; // 'II'
	if (!little && order !== 0x4d4d) return null;
	const u16 = (at) => view.getUint16(tiff + at, little);
	const u32 = (at) => view.getUint32(tiff + at, little);
	if (u16(2) !== 42) return null;

	// IFD0: find the GPS IFD pointer (0x8825) and the Exif IFD (0x8769).
	const readIfd = (at) => {
		const entries = new Map();
		const count = u16(at);
		for (let i = 0; i < count; i++) {
			const entry = at + 2 + i * 12;
			entries.set(u16(entry), entry);
		}
		return entries;
	};
	const valueOffset = (entry) => {
		const type = u16(entry + 2);
		const count = u32(entry + 4);
		const bytes = (TYPE_SIZE[type] ?? 1) * count;
		return bytes <= 4 ? entry + 8 : u32(entry + 8);
	};

	const ifd0 = readIfd(u32(4));
	const gpsEntry = ifd0.get(0x8825);
	if (!gpsEntry) return null;
	const gps = readIfd(u32(gpsEntry + 8));

	const latRef = gps.has(0x0001) ? String.fromCharCode(view.getUint8(tiff + valueOffset(gps.get(0x0001)))) : 'N';
	const longRef = gps.has(0x0003) ? String.fromCharCode(view.getUint8(tiff + valueOffset(gps.get(0x0003)))) : 'E';
	const dms = (entry) => {
		const at = valueOffset(entry);
		const rational = (i) => {
			const den = u32(at + i * 8 + 4);
			return den === 0 ? 0 : u32(at + i * 8) / den;
		};
		return rational(0) + rational(1) / 60 + rational(2) / 3600;
	};
	if (!gps.has(0x0002) || !gps.has(0x0004)) return null;
	const lat = dms(gps.get(0x0002)) * (latRef === 'S' ? -1 : 1);
	const long = dms(gps.get(0x0004)) * (longRef === 'W' ? -1 : 1);
	if (!Number.isFinite(lat) || !Number.isFinite(long) || (lat === 0 && long === 0)) return null;

	const result = { lat, long };

	// Capture time (DateTimeOriginal in the Exif sub-IFD), when present.
	const exifEntry = ifd0.get(0x8769);
	if (exifEntry) {
		const exif = readIfd(u32(exifEntry + 8));
		const dt = exif.get(0x9003);
		if (dt) {
			const at = tiff + valueOffset(dt);
			let s = '';
			for (let i = 0; i < 19 && at + i < view.byteLength; i++) {
				const c = view.getUint8(at + i);
				if (c === 0) break;
				s += String.fromCharCode(c);
			}
			if (s.length === 19) result.time = s;
		}
	}
	return result;
}
