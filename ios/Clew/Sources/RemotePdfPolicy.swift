// Web PDFs, the rules (Clew-app docs/dev/pdf-unification.md §4, §8): which
// URLs Clew may fetch, which addresses it may connect to, which answers it
// accepts. Foundation only and free of I/O — the resolver and the HTTP
// transport are injected — so every rule here is unit-tested with fakes
// (ios/Tests/RemotePdfPolicyTests.swift, `npm run test:swift`), never
// against a real network. RemotePdfFetcher.swift supplies the real
// resolver (getaddrinfo) and transport (Network.framework, pinned to the
// vetted address, SNI and certificate checked against the original host).
import Foundation

// MARK: - Addresses

/// An IP address, as bytes (4 or 16).
struct IPAddress: Equatable, CustomStringConvertible {
	let bytes: [UInt8]

	init?(bytes: [UInt8]) {
		guard bytes.count == 4 || bytes.count == 16 else { return nil }
		self.bytes = bytes
	}

	/// Dotted IPv4 or any textual IPv6 form (inet_pton's grammar).
	init?(_ text: String) {
		var v4 = in_addr()
		if text.withCString({ inet_pton(AF_INET, $0, &v4) }) == 1 {
			self.bytes = withUnsafeBytes(of: &v4) { Array($0) }
			return
		}
		var v6 = in6_addr()
		if text.withCString({ inet_pton(AF_INET6, $0, &v6) }) == 1 {
			self.bytes = withUnsafeBytes(of: &v6) { Array($0) }
			return
		}
		return nil
	}

	var isV4: Bool { bytes.count == 4 }

	var description: String {
		var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
		var copy = bytes
		let family = isV4 ? AF_INET : AF_INET6
		_ = copy.withUnsafeMutableBytes { raw in
			inet_ntop(family, raw.baseAddress, &buffer, socklen_t(buffer.count))
		}
		return String(cString: buffer)
	}
}

enum AddressGuard {
	/// Why `address` must not be connected to, or nil when it is public.
	/// Loopback, private, link-local (the cloud metadata address among them),
	/// CGNAT, "this network", multicast, reserved and documentation ranges —
	/// and the IPv4-mapped, IPv4-compatible, NAT64 and 6to4 forms of all of
	/// them, judged by the IPv4 address they carry.
	static func refusal(_ address: IPAddress) -> String? {
		address.isV4 ? refusalV4(address.bytes) : refusalV6(address.bytes)
	}

	private static func inV4(_ b: [UInt8], _ net: [UInt8], _ prefix: Int) -> Bool {
		matches(b, net, prefix)
	}

	private static func refusalV4(_ b: [UInt8]) -> String? {
		let ranges: [([UInt8], Int, String)] = [
			([0, 0, 0, 0], 8, "this network (0/8)"),
			([10, 0, 0, 0], 8, "private (10/8)"),
			([100, 64, 0, 0], 10, "CGNAT (100.64/10)"),
			([127, 0, 0, 0], 8, "loopback (127/8)"),
			([169, 254, 0, 0], 16, "link-local (169.254/16, cloud metadata)"),
			([172, 16, 0, 0], 12, "private (172.16/12)"),
			([192, 0, 0, 0], 24, "IETF protocol assignments (192.0.0/24)"),
			([192, 0, 2, 0], 24, "documentation (192.0.2/24)"),
			([192, 88, 99, 0], 24, "6to4 relay (192.88.99/24)"),
			([192, 168, 0, 0], 16, "private (192.168/16)"),
			([198, 18, 0, 0], 15, "benchmarking (198.18/15)"),
			([198, 51, 100, 0], 24, "documentation (198.51.100/24)"),
			([203, 0, 113, 0], 24, "documentation (203.0.113/24)"),
			([224, 0, 0, 0], 4, "multicast (224/4)"),
			([240, 0, 0, 0], 4, "reserved (240/4)"),
		]
		for (net, prefix, why) in ranges where inV4(b, net, prefix) { return why }
		return nil
	}

	private static func refusalV6(_ b: [UInt8]) -> String? {
		let zero10: [UInt8] = Array(repeating: 0, count: 10)
		let embedded = { (offset: Int, form: String) -> String? in
			let v4 = Array(b[offset..<(offset + 4)])
			return refusalV4(v4).map { "\(form) of \($0)" }
		}
		if b == Array(repeating: 0, count: 16) { return "unspecified (::)" }
		if b == Array(repeating: 0, count: 15) + [1] { return "loopback (::1)" }
		// ::ffff:a.b.c.d — IPv4-mapped.
		if Array(b[0..<10]) == zero10 && b[10] == 0xff && b[11] == 0xff { return embedded(12, "IPv4-mapped") }
		// ::ffff:0:a.b.c.d — IPv4-translated.
		if Array(b[0..<8]) == Array(repeating: 0, count: 8) && b[8] == 0xff && b[9] == 0xff && b[10] == 0 && b[11] == 0 {
			return embedded(12, "IPv4-translated")
		}
		// ::a.b.c.d — IPv4-compatible (deprecated): any other ::/96.
		if Array(b[0..<12]) == Array(repeating: 0, count: 12) { return embedded(12, "IPv4-compatible") ?? "IPv4-compatible (::/96, deprecated)" }
		// 64:ff9b::a.b.c.d — well-known NAT64: public inside is fine (a
		// NAT64-only network reaches every IPv4 site this way).
		if matches(b, [0x00, 0x64, 0xff, 0x9b] + Array(repeating: 0, count: 12), 96) { return embedded(12, "NAT64") }
		if matches(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01] + Array(repeating: 0, count: 10), 48) { return "local-use NAT64 (64:ff9b:1::/48)" }
		// 2002:a.b.c.d::/48 — 6to4.
		if matches(b, [0x20, 0x02] + Array(repeating: 0, count: 14), 16) { return embedded(2, "6to4") }
		let ranges: [([UInt8], Int, String)] = [
			([0x01, 0x00] + Array(repeating: 0, count: 14), 64, "discard (100::/64)"),
			([0x20, 0x01, 0x0d, 0xb8] + Array(repeating: 0, count: 12), 32, "documentation (2001:db8::/32)"),
			([0x20, 0x01] + Array(repeating: 0, count: 14), 23, "IETF special (2001::/23, Teredo among them)"),
			([0xfc] + Array(repeating: 0, count: 15), 7, "unique local (fc00::/7)"),
			([0xfe, 0x80] + Array(repeating: 0, count: 14), 10, "link-local (fe80::/10)"),
			([0xfe, 0xc0] + Array(repeating: 0, count: 14), 10, "site-local (fec0::/10)"),
			([0xff] + Array(repeating: 0, count: 15), 8, "multicast (ff00::/8)"),
		]
		for (net, prefix, why) in ranges where matches(b, net, prefix) { return why }
		return nil
	}

	private static func matches(_ b: [UInt8], _ net: [UInt8], _ prefix: Int) -> Bool {
		guard b.count == net.count else { return false }
		var bits = prefix
		for i in 0..<b.count where bits > 0 {
			let take = min(8, bits)
			let mask = UInt8(truncatingIfNeeded: 0xff << (8 - take))
			if b[i] & mask != net[i] & mask { return false }
			bits -= take
		}
		return true
	}

	/// The addresses a host resolved to, vetted as a whole: if ANY is
	/// refused, the host is (a DNS answer that mixes a public address with a
	/// private one is refused outright — no picking the "good" one). The
	/// connection is then made to the first, pinned, so the answer cannot
	/// change between this check and the connect.
	static func vet(_ addresses: [IPAddress], host: String) throws -> IPAddress {
		guard let first = addresses.first else { throw RemotePdfError.dns("\(host) resolved to no address") }
		for address in addresses {
			if let why = refusal(address) {
				throw RemotePdfError.refusedAddress("\(host) → \(address): \(why)")
			}
		}
		return first
	}
}

// MARK: - Errors, named for the viewer

enum RemotePdfError: Error, Equatable {
	case insecureURL(String)      // http:, or any other scheme — https only on iOS
	case badURL(String)
	case dns(String)
	case refusedAddress(String)
	case tooManyRedirects
	case connectTimeout
	case headersTimeout
	case totalTimeout
	case tooLarge(Int)
	case httpStatus(Int)
	case htmlAnswer               // "The site answered with a web page, not a PDF"
	case notPDF(String)
	case network(String)

	/// A short machine name for the viewer, which words the message: the
	/// vocabulary of the shared preview-client/remote-failures.js (Clew-app
	/// db50f57), which also words `insecure-url` — the iPad's alone (§8,
	/// https only).
	var code: String {
		switch self {
		case .insecureURL: return "insecure-url"
		case .badURL: return "bad-url"
		case .dns: return "dns"
		case .refusedAddress: return "refused-address"
		case .tooManyRedirects: return "too-many-redirects"
		case .connectTimeout: return "connect-timeout"
		case .headersTimeout: return "headers-timeout"
		case .totalTimeout: return "timeout"
		case .tooLarge: return "too-large"
		case .httpStatus: return "http-status"
		case .htmlAnswer: return "web-page"
		case .notPDF: return "not-pdf"
		case .network: return "network"
		}
	}

	var detail: String {
		switch self {
		case .insecureURL(let s), .badURL(let s), .dns(let s), .refusedAddress(let s), .notPDF(let s), .network(let s): return s
		case .tooManyRedirects: return "more than \(RemotePdfPolicy.maxRedirects) redirects"
		case .connectTimeout: return "no connection within \(Int(RemotePdfPolicy.connectTimeout)) s"
		case .headersTimeout: return "no answer within \(Int(RemotePdfPolicy.headersTimeout)) s"
		case .totalTimeout: return "not finished within \(Int(RemotePdfPolicy.totalTimeout)) s"
		// The viewer's head line states no size (Clew-app db50f57): the
		// iPad's cap (§8) is said here.
		case .tooLarge(let cap): return "larger than the \(cap / 1_000_000) MB a web PDF may be"
		case .httpStatus(let status): return "the site answered \(status)"
		case .htmlAnswer: return "the site answered with a web page, not a PDF — it may need you to sign in"
		}
	}
}

// MARK: - URLs, answers, the fetch loop

enum RemotePdfPolicy {
	static let maxRedirects = 5
	static let sizeCap = 50_000_000   // the iPad's (desktop 100 MB)
	static let connectTimeout: TimeInterval = 10
	static let headersTimeout: TimeInterval = 20
	static let totalTimeout: TimeInterval = 120

	/// https only (App Transport Security's rule, enforced here in code: it
	/// does not cover Network.framework), a host, no credentials in the URL.
	static func checkURL(_ url: URL) throws {
		guard url.scheme?.lowercased() == "https" else {
			throw RemotePdfError.insecureURL("\(url.scheme ?? "?"): — only https:// PDFs are fetched on iPad")
		}
		guard let host = url.host, !host.isEmpty else { throw RemotePdfError.badURL("no host in \(url.absoluteString)") }
		if url.user != nil || url.password != nil { throw RemotePdfError.badURL("credentials in the URL") }
		if let port = url.port, !(1...65535).contains(port) { throw RemotePdfError.badURL("port \(port)") }
	}

	/// Where a redirect goes: `Location` resolved against the current URL.
	static func redirectTarget(from current: URL, location: String) throws -> URL {
		guard let target = URL(string: location, relativeTo: current)?.absoluteURL else {
			throw RemotePdfError.badURL("unreadable redirect \(location)")
		}
		return target
	}

	static let genericBinaryTypes: Set<String> = [
		"application/octet-stream", "binary/octet-stream", "application/download",
		"application/force-download", "application/x-download", "application/x-pdf",
	]

	/// `application/pdf` or a generic binary type (or none said); an HTML
	/// answer is named as such — usually a login page.
	static func checkContentType(_ raw: String?) throws {
		guard let raw, !raw.isEmpty else { return }
		let type = raw.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
		if type == "application/pdf" || genericBinaryTypes.contains(type) { return }
		if type == "text/html" || type == "application/xhtml+xml" { throw RemotePdfError.htmlAnswer }
		throw RemotePdfError.notPDF("Content-Type \(type)")
	}

	/// `%PDF-` within the first 1024 bytes (the PDF specification's allowance).
	static func hasPDFMagic(_ prefix: Data) -> Bool {
		let window = prefix.prefix(1024)
		let magic = Data("%PDF-".utf8)
		return window.range(of: magic) != nil
	}

	static let redirectStatuses: Set<Int> = [301, 302, 303, 307, 308]
}

/// Resolves a host name to its addresses (the real one: getaddrinfo).
protocol RemotePdfResolver {
	func resolve(_ host: String) throws -> [IPAddress]
}

/// One HTTP GET, made to `address` (pinned) for `url`'s host.
struct RemotePdfResponse {
	var status: Int
	var headers: [String: String]   // lower-cased names
	var prefix: Data                // the body's first bytes (up to 1024)
	var bodyFile: URL?              // the whole body, streamed to disk (200 only)
	var bytes: Int
}

protocol RemotePdfTransport {
	/// Sends `GET` with exactly `headers`; streams a 200's body to disk,
	/// throwing `.tooLarge(limit)` once it passes `limit` bytes.
	func get(_ url: URL, at address: IPAddress, headers: [String: String], limit: Int) throws -> RemotePdfResponse
}

enum RemotePdfOutcome {
	case fetched(RemotePdfResponse, finalURL: URL)
	case notModified
}

/// The loop: check the URL, resolve, vet EVERY address, connect to the
/// vetted one, follow at most 5 redirects — each hop checked the same way —
/// and accept only a PDF.
struct RemotePdfFetch {
	let resolver: RemotePdfResolver
	let transport: RemotePdfTransport
	var userAgent = "Clew"

	func run(_ start: URL, etag: String? = nil, lastModified: String? = nil) throws -> RemotePdfOutcome {
		var url = start
		var hops = 0
		while true {
			try RemotePdfPolicy.checkURL(url)
			let host = url.host!
			let address = try AddressGuard.vet(try resolver.resolve(host), host: host)
			var headers = [
				"User-Agent": userAgent,
				"Accept": "application/pdf, */*;q=0.1",
				"Accept-Encoding": "identity",
			]
			// Conditional GET only against the URL the cache holds.
			if hops == 0 {
				if let etag { headers["If-None-Match"] = etag }
				if let lastModified { headers["If-Modified-Since"] = lastModified }
			}
			let response = try transport.get(url, at: address, headers: headers, limit: RemotePdfPolicy.sizeCap)
			if response.status == 304 && hops == 0 && (etag != nil || lastModified != nil) { return .notModified }
			if RemotePdfPolicy.redirectStatuses.contains(response.status) {
				guard let location = response.headers["location"] else { throw RemotePdfError.httpStatus(response.status) }
				hops += 1
				if hops > RemotePdfPolicy.maxRedirects { throw RemotePdfError.tooManyRedirects }
				url = try RemotePdfPolicy.redirectTarget(from: url, location: location)
				continue
			}
			guard response.status == 200 else { throw RemotePdfError.httpStatus(response.status) }
			try RemotePdfPolicy.checkContentType(response.headers["content-type"])
			guard RemotePdfPolicy.hasPDFMagic(response.prefix) else {
				throw RemotePdfError.notPDF("no %PDF- in the first 1024 bytes")
			}
			return .fetched(response, finalURL: url)
		}
	}
}

// MARK: - HTTP/1.1, the part the transport parses

enum HTTPHead {
	/// Parses a response head (status line + headers, without the blank line).
	static func parse(_ head: Data) throws -> (status: Int, headers: [String: String]) {
		guard let text = String(data: head, encoding: .isoLatin1) else { throw RemotePdfError.network("unreadable head") }
		var lines = text.components(separatedBy: "\r\n")
		guard !lines.isEmpty else { throw RemotePdfError.network("empty head") }
		let statusLine = lines.removeFirst().split(separator: " ", maxSplits: 2)
		guard statusLine.count >= 2, statusLine[0].hasPrefix("HTTP/1."), let status = Int(statusLine[1]) else {
			throw RemotePdfError.network("bad status line")
		}
		var headers: [String: String] = [:]
		for line in lines where !line.isEmpty {
			guard let colon = line.firstIndex(of: ":") else { throw RemotePdfError.network("bad header line") }
			let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
			let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
			if headers[name] == nil { headers[name] = value }
		}
		return (status, headers)
	}

	/// Where the head ends in `buffer` (the index after the blank line).
	static func headEnd(_ buffer: Data) -> Int? {
		buffer.range(of: Data("\r\n\r\n".utf8)).map { $0.upperBound - buffer.startIndex }
	}
}

/// `Transfer-Encoding: chunked`, decoded incrementally: feed it whatever
/// arrived; it hands back body bytes and says when the last chunk is in.
struct ChunkedDecoder {
	private var buffer = Data()
	private var remaining: Int? = nil   // bytes left in the current chunk
	private(set) var done = false

	mutating func feed(_ data: Data) throws -> Data {
		buffer.append(data)
		var out = Data()
		while !done {
			if let left = remaining {
				if left == 0 {
					// The CRLF after a chunk's data.
					guard buffer.count >= 2 else { break }
					guard buffer.prefix(2) == Data("\r\n".utf8) else { throw RemotePdfError.network("bad chunk end") }
					buffer.removeFirst(2)
					remaining = nil
					continue
				}
				let take = min(left, buffer.count)
				if take == 0 { break }
				out.append(buffer.prefix(take))
				buffer.removeFirst(take)
				remaining = left - take
			} else {
				guard let lineEnd = buffer.range(of: Data("\r\n".utf8)) else { break }
				let line = String(data: buffer[buffer.startIndex..<lineEnd.lowerBound], encoding: .ascii) ?? ""
				buffer.removeSubrange(buffer.startIndex..<lineEnd.upperBound)
				let sizeText = line.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
				guard let size = Int(sizeText, radix: 16), size >= 0 else { throw RemotePdfError.network("bad chunk size") }
				if size == 0 { done = true; break }   // trailers are ignored
				remaining = size
			}
		}
		return out
	}
}
