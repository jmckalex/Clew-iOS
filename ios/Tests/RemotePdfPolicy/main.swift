// Unit tests for ios/Clew/Sources/RemotePdfPolicy.swift — the web-PDF
// address guard, URL rules, answer checks and fetch loop. Defensive only:
// a fake resolver and a fake transport, never a real network.
//   npm run test:swift   (scripts/test-swift.sh compiles this with the policy)
import Foundation

var passed = 0
var failed = 0

func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}

func expectError(_ name: String, line: Int = #line, _ matches: (RemotePdfError) -> Bool, _ body: () throws -> Void) {
	do {
		try body()
		failed += 1; print("FAIL [\(line)] \(name): no error thrown")
	} catch let error as RemotePdfError {
		if matches(error) { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name): got \(error)") }
	} catch {
		failed += 1; print("FAIL [\(line)] \(name): unexpected \(error)")
	}
}

func ip(_ text: String) -> IPAddress {
	guard let address = IPAddress(text) else { fatalError("unparseable test address \(text)") }
	return address
}

// MARK: - Fakes

struct FakeResolver: RemotePdfResolver {
	var answers: [String: [String]]
	func resolve(_ host: String) throws -> [IPAddress] {
		guard let list = answers[host.lowercased()] else { throw RemotePdfError.dns("no such host \(host)") }
		return list.map(ip)
	}
}

final class FakeTransport: RemotePdfTransport {
	var responses: [String: RemotePdfResponse] = [:]
	var errors: [String: RemotePdfError] = [:]
	var calls: [(url: URL, address: IPAddress, headers: [String: String])] = []
	func get(_ url: URL, at address: IPAddress, headers: [String: String], limit: Int) throws -> RemotePdfResponse {
		calls.append((url, address, headers))
		if let error = errors[url.absoluteString] { throw error }
		guard let response = responses[url.absoluteString] else { throw RemotePdfError.httpStatus(404) }
		return response
	}
}

func pdf(_ type: String? = "application/pdf", prefix: String = "%PDF-1.7\n") -> RemotePdfResponse {
	var headers: [String: String] = [:]
	if let type { headers["content-type"] = type }
	return RemotePdfResponse(status: 200, headers: headers, prefix: Data(prefix.utf8), bodyFile: nil, bytes: 1234)
}

func redirect(_ status: Int = 302, to location: String) -> RemotePdfResponse {
	RemotePdfResponse(status: status, headers: ["location": location], prefix: Data(), bodyFile: nil, bytes: 0)
}

// MARK: - The address guard: every refused range

let refusedV4 = [
	"0.0.0.0", "0.1.2.3",
	"10.0.0.0", "10.255.255.255",
	"100.64.0.0", "100.100.100.100", "100.127.255.255",
	"127.0.0.1", "127.255.255.254",
	"169.254.0.1", "169.254.169.254",
	"172.16.0.0", "172.20.1.1", "172.31.255.255",
	"192.0.0.1", "192.0.2.1", "192.88.99.1",
	"192.168.0.1", "192.168.255.255",
	"198.18.0.0", "198.19.255.255",
	"198.51.100.7", "203.0.113.9",
	"224.0.0.1", "239.255.255.255",
	"240.0.0.1", "255.255.255.255",
]
for text in refusedV4 { check(AddressGuard.refusal(ip(text)) != nil, "refuses \(text)") }

let publicV4 = [
	"8.8.8.8", "1.1.1.1", "93.184.216.34",
	"9.255.255.255", "11.0.0.0",            // around 10/8
	"100.63.255.255", "100.128.0.0",        // around CGNAT
	"126.255.255.255", "128.0.0.0",         // around 127/8
	"169.253.255.255", "169.255.0.0",       // around link-local
	"172.15.255.255", "172.32.0.0",         // around 172.16/12
	"192.167.255.255", "192.169.0.0",       // around 192.168/16
	"198.17.255.255", "198.20.0.0",         // around 198.18/15
	"223.255.255.255",                      // below multicast
]
for text in publicV4 { check(AddressGuard.refusal(ip(text)) == nil, "allows \(text)") }

let refusedV6 = [
	"::", "::1", "0:0:0:0:0:0:0:1",
	"::ffff:127.0.0.1", "::FFFF:7F00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:192.168.1.1",
	"::ffff:0:192.168.1.1",                 // IPv4-translated
	"::127.0.0.1", "::8.8.8.8",             // IPv4-compatible: deprecated, all refused
	"64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::169.254.169.254",
	"64:ff9b:1::1",                         // local-use NAT64
	"2002:c0a8:0101::1", "2002:7f00:0001::1", "2002:0a00:0001::",   // 6to4 of private/loopback
	"100::1",
	"2001:db8::1", "2001:db8:ffff::1",
	"2001::1", "2001:0:4136:e378::1", "2001:1ff::1",   // IETF special incl. Teredo
	"fc00::1", "fd00:ec2::254", "fdff:ffff::1",
	"fe80::1", "febf:ffff::1", "fec0::1",
	"ff02::1", "ff05::1:3",
]
for text in refusedV6 { check(AddressGuard.refusal(ip(text)) != nil, "refuses \(text)") }

let publicV6 = [
	"2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4009:81f::200e",
	"::ffff:8.8.8.8",                       // mapped public
	"64:ff9b::8.8.8.8", "64:ff9b::5db8:d822",   // NAT64 of public (the NAT64-only network case)
	"2002:0808:0808::1",                    // 6to4 of public
	"2001:200::1",                          // just past 2001::/23
	"fbff:ffff::1",                         // just below fc00::/7
]
for text in publicV6 { check(AddressGuard.refusal(ip(text)) == nil, "allows \(text)") }

check(AddressGuard.refusal(ip("::ffff:169.254.169.254"))?.contains("IPv4-mapped") == true, "mapped refusals name the form")
check(AddressGuard.refusal(ip("64:ff9b::10.0.0.1"))?.contains("NAT64") == true, "NAT64 refusals name the form")

// MARK: - Vetting a whole DNS answer

check((try? AddressGuard.vet([ip("93.184.216.34"), ip("2606:2800:220:1::1")], host: "a")) == ip("93.184.216.34"),
	"an all-public answer pins its first address")
expectError("a mixed answer is refused (public first)", { if case .refusedAddress = $0 { return true }; return false }) {
	_ = try AddressGuard.vet([ip("93.184.216.34"), ip("10.0.0.5")], host: "mixed.example")
}
expectError("a mixed answer is refused (private first)", { if case .refusedAddress = $0 { return true }; return false }) {
	_ = try AddressGuard.vet([ip("10.0.0.5"), ip("93.184.216.34")], host: "mixed.example")
}
expectError("a mixed answer with a mapped loopback is refused", { if case .refusedAddress = $0 { return true }; return false }) {
	_ = try AddressGuard.vet([ip("2606:2800:220:1::1"), ip("::ffff:127.0.0.1")], host: "mixed.example")
}
expectError("no address", { if case .dns = $0 { return true }; return false }) {
	_ = try AddressGuard.vet([], host: "empty.example")
}

// MARK: - URLs

expectError("http:// is refused (https only)", { if case .insecureURL = $0 { return true }; return false }) {
	try RemotePdfPolicy.checkURL(URL(string: "http://example.com/a.pdf")!)
}
expectError("ftp:// is refused", { if case .insecureURL = $0 { return true }; return false }) {
	try RemotePdfPolicy.checkURL(URL(string: "ftp://example.com/a.pdf")!)
}
expectError("credentials in the URL are refused", { if case .badURL = $0 { return true }; return false }) {
	try RemotePdfPolicy.checkURL(URL(string: "https://user:pw@example.com/a.pdf")!)
}
check((try? RemotePdfPolicy.checkURL(URL(string: "https://example.com/papers/a.pdf")!)) != nil, "https:// is accepted")
check((try? RemotePdfPolicy.redirectTarget(from: URL(string: "https://example.com/dir/a.pdf")!, location: "/b.pdf"))?.absoluteString
	== "https://example.com/b.pdf", "a relative Location resolves against the current URL")

// MARK: - Answers

check((try? RemotePdfPolicy.checkContentType("application/pdf")) != nil, "application/pdf")
check((try? RemotePdfPolicy.checkContentType("application/pdf; charset=binary")) != nil, "application/pdf with parameters")
check((try? RemotePdfPolicy.checkContentType("application/octet-stream")) != nil, "a generic binary type")
check((try? RemotePdfPolicy.checkContentType(nil)) != nil, "no Content-Type: judged by the magic")
expectError("text/html is named as an HTML answer", { $0 == .htmlAnswer }) { try RemotePdfPolicy.checkContentType("text/html; charset=utf-8") }
expectError("image/png is not a PDF", { if case .notPDF = $0 { return true }; return false }) { try RemotePdfPolicy.checkContentType("image/png") }
check(RemotePdfPolicy.hasPDFMagic(Data("%PDF-1.4".utf8)), "magic at 0")
check(RemotePdfPolicy.hasPDFMagic(Data((String(repeating: " ", count: 500) + "%PDF-1.4").utf8)), "magic at 500 (the spec's allowance)")
check(!RemotePdfPolicy.hasPDFMagic(Data((String(repeating: " ", count: 2000) + "%PDF-1.4").utf8)), "magic past 1024 does not count")
check(!RemotePdfPolicy.hasPDFMagic(Data("<!doctype html>".utf8)), "HTML has no magic")

// MARK: - The fetch loop

let resolver = FakeResolver(answers: [
	"example.com": ["93.184.216.34"],
	"cdn.example.com": ["2606:2800:220:1::1"],
	"internal.example.com": ["192.168.0.10"],
	"rebind.example.com": ["93.184.216.35", "127.0.0.1"],
	"127.0.0.1": ["127.0.0.1"],
	"169.254.169.254": ["169.254.169.254"],
	"::1": ["::1"],
])

do {
	let t = FakeTransport()
	t.responses["https://example.com/a.pdf"] = pdf()
	let outcome = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/a.pdf")!)
	if case .fetched(_, let final) = outcome { check(final.absoluteString == "https://example.com/a.pdf", "fetched at its own URL") }
	else { check(false, "a plain PDF fetches") }
	check(t.calls.count == 1 && t.calls[0].address == ip("93.184.216.34"), "the connection goes to the vetted address")
	let h = t.calls[0].headers
	check(h["Cookie"] == nil && h["Authorization"] == nil && h["Referer"] == nil, "no cookies, no Authorization, no Referer")
	check(h["User-Agent"] == "Clew" && h["Accept-Encoding"] == "identity", "a plain User-Agent, no compression")
} catch { check(false, "happy path threw \(error)") }

do {
	let t = FakeTransport()
	t.responses["https://example.com/a.pdf"] = redirect(to: "https://internal.example.com/secret.pdf")
	t.responses["https://internal.example.com/secret.pdf"] = pdf()
	expectError("a redirect to a private address is refused", { if case .refusedAddress = $0 { return true }; return false }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/a.pdf")!)
	}
	check(t.calls.count == 1, "…and never connected to (only the first hop was)")
}

for literal in ["https://127.0.0.1/x.pdf", "https://169.254.169.254/latest/meta-data", "https://[::1]/x.pdf"] {
	let t = FakeTransport()
	t.responses["https://example.com/a.pdf"] = redirect(301, to: literal)
	expectError("a redirect to the literal \(literal) is refused", { if case .refusedAddress = $0 { return true }; return false }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/a.pdf")!)
	}
	check(t.calls.count == 1, "…never connected to \(literal)")
}

do {
	let t = FakeTransport()
	expectError("a host whose answer mixes public and loopback is refused before any connection",
		{ if case .refusedAddress = $0 { return true }; return false }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://rebind.example.com/a.pdf")!)
	}
	check(t.calls.isEmpty, "…with no connection at all")
}

do {
	let t = FakeTransport()
	t.responses["https://example.com/a.pdf"] = redirect(to: "http://example.com/a.pdf")
	expectError("a redirect down to http:// is refused", { if case .insecureURL = $0 { return true }; return false }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/a.pdf")!)
	}
}

do {
	let t = FakeTransport()
	t.responses["https://example.com/a.pdf"] = redirect(to: "/b.pdf")
	t.responses["https://example.com/b.pdf"] = redirect(307, to: "https://cdn.example.com/c.pdf")
	t.responses["https://cdn.example.com/c.pdf"] = pdf("application/octet-stream")
	let outcome = try? RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/a.pdf")!)
	if case .fetched(_, let final)? = outcome { check(final.absoluteString == "https://cdn.example.com/c.pdf", "follows relative and cross-host redirects") }
	else { check(false, "redirect chain fetched") }
	check(t.calls.last?.address == ip("2606:2800:220:1::1"), "each hop pins its own vetted address")
}

do {
	// Exactly 5 redirects are followed; a 6th is refused.
	func chain(_ n: Int) -> FakeTransport {
		let t = FakeTransport()
		for i in 0..<n { t.responses["https://example.com/\(i).pdf"] = redirect(to: "https://example.com/\(i + 1).pdf") }
		t.responses["https://example.com/\(n).pdf"] = pdf()
		return t
	}
	check((try? RemotePdfFetch(resolver: resolver, transport: chain(5)).run(URL(string: "https://example.com/0.pdf")!)) != nil, "5 redirects are followed")
	expectError("a 6th redirect is refused", { $0 == .tooManyRedirects }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: chain(6)).run(URL(string: "https://example.com/0.pdf")!)
	}
}

do {
	let t = FakeTransport()
	t.responses["https://example.com/login.pdf"] = pdf("text/html", prefix: "<!doctype html><title>Sign in</title>")
	expectError("an HTML answer is named", { $0 == .htmlAnswer }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/login.pdf")!)
	}
	t.responses["https://example.com/fake.pdf"] = pdf("application/pdf", prefix: "<html>not really")
	expectError("a PDF type without the magic is refused", { if case .notPDF = $0 { return true }; return false }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/fake.pdf")!)
	}
	t.responses["https://example.com/gone.pdf"] = RemotePdfResponse(status: 404, headers: [:], prefix: Data(), bodyFile: nil, bytes: 0)
	expectError("an HTTP error is named by status", { $0 == .httpStatus(404) }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/gone.pdf")!)
	}
	t.errors["https://example.com/huge.pdf"] = .tooLarge(RemotePdfPolicy.sizeCap)
	expectError("the size cap surfaces as too-large", { $0 == .tooLarge(RemotePdfPolicy.sizeCap) }) {
		_ = try RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/huge.pdf")!)
	}
}

do {
	let t = FakeTransport()
	t.responses["https://example.com/a.pdf"] = RemotePdfResponse(status: 304, headers: [:], prefix: Data(), bodyFile: nil, bytes: 0)
	let outcome = try? RemotePdfFetch(resolver: resolver, transport: t).run(URL(string: "https://example.com/a.pdf")!, etag: "\"v1\"")
	if case .notModified? = outcome { check(true, "a 304 to a conditional GET is not-modified") } else { check(false, "conditional GET") }
	check(t.calls[0].headers["If-None-Match"] == "\"v1\"", "the ETag is sent")
	let t2 = FakeTransport()
	t2.responses["https://example.com/a.pdf"] = redirect(to: "https://cdn.example.com/c.pdf")
	t2.responses["https://cdn.example.com/c.pdf"] = pdf()
	_ = try? RemotePdfFetch(resolver: resolver, transport: t2).run(URL(string: "https://example.com/a.pdf")!, etag: "\"v1\"")
	check(t2.calls.count == 2 && t2.calls[1].headers["If-None-Match"] == nil, "validators are not carried across a redirect")
}

// MARK: - HTTP parsing

do {
	let head = try HTTPHead.parse(Data("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nX-Twice: first\r\nX-Twice: second".utf8))
	check(head.status == 200 && head.headers["content-type"] == "application/pdf", "status line and lower-cased headers")
	check(head.headers["x-twice"] == "first", "a repeated header keeps its first value")
} catch { check(false, "head parse threw \(error)") }
expectError("a bad status line is refused", { if case .network = $0 { return true }; return false }) {
	_ = try HTTPHead.parse(Data("SPDY 200\r\n".utf8))
}
check(HTTPHead.headEnd(Data("HTTP/1.1 200 OK\r\nA: b\r\n\r\n%PDF".utf8)) == 25, "the head ends after the blank line (17 + 6 + 2 bytes)")

do {
	var decoder = ChunkedDecoder()
	var body = Data()
	for byte in Data("5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\n\r\n".utf8) { body.append(try decoder.feed(Data([byte]))) }
	check(String(data: body, encoding: .utf8) == "hello world" && decoder.done, "chunked, fed a byte at a time")
} catch { check(false, "chunked threw \(error)") }
do {
	var decoder = ChunkedDecoder()
	expectError("a bad chunk size is refused", { if case .network = $0 { return true }; return false }) { _ = try decoder.feed(Data("zz\r\n".utf8)) }
}

// The viewer words a failure from its code (the shared
// preview-client/remote-failures.js, Clew-app db50f57): every code native
// sends must be one it names — the iPad's https-only refusal included.
do {
	let viewerCodes: Set<String> = ["web-page", "not-pdf", "too-large", "refused-address", "bad-url", "timeout",
		"headers-timeout", "connect-timeout", "too-many-redirects", "http-status", "dns", "network", "insecure-url"]
	let every: [RemotePdfError] = [.insecureURL("x"), .badURL("x"), .dns("x"), .refusedAddress("x"), .tooManyRedirects,
		.connectTimeout, .headersTimeout, .totalTimeout, .tooLarge(50_000_000), .httpStatus(403), .htmlAnswer,
		.notPDF("x"), .network("x")]
	for error in every {
		check(viewerCodes.contains(error.code), "the viewer names \(error.code)")
	}
	check(RemotePdfError.tooLarge(50_000_000).detail.contains("50 MB"), "too-large says the iPad's cap (the head line no longer does)")
}

print("RemotePdfPolicy: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
