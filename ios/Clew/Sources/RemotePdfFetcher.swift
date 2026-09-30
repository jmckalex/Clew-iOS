// Web PDFs, the I/O half (Clew-app docs/dev/pdf-unification.md §4, §8): the
// real resolver and the real HTTP transport behind RemotePdfPolicy.swift's
// fetch loop. The address is resolved FIRST (getaddrinfo), vetted by
// AddressGuard, and the connection is made to that address — pinned — by
// Network.framework, with the TLS server name AND the certificate check set
// to the ORIGINAL host (URLSession cannot pin: it resolves internally, and
// rewriting the URL to the IP would send the IP as SNI). A minimal
// HTTP/1.1 GET, `Connection: close`, no proxies, no cookies; the body is
// streamed to disk and counted against the cap as it arrives.
import Foundation
import Network
import Security

/// getaddrinfo, every address of both families. On a NAT64-only network the
/// system synthesises 64:ff9b:: forms, which AddressGuard judges by the IPv4
/// address inside.
struct SystemResolver: RemotePdfResolver {
	func resolve(_ host: String) throws -> [IPAddress] {
		var hints = addrinfo()
		hints.ai_family = AF_UNSPEC
		hints.ai_socktype = SOCK_STREAM
		var result: UnsafeMutablePointer<addrinfo>?
		let status = getaddrinfo(host, nil, &hints, &result)
		guard status == 0, let first = result else {
			throw RemotePdfError.dns("\(host): \(String(cString: gai_strerror(status)))")
		}
		defer { freeaddrinfo(first) }
		var addresses: [IPAddress] = []
		var cursor: UnsafeMutablePointer<addrinfo>? = first
		while let info = cursor {
			if let sa = info.pointee.ai_addr {
				switch Int32(sa.pointee.sa_family) {
				case AF_INET:
					var bytes = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
					if let address = IPAddress(bytes: withUnsafeBytes(of: &bytes) { Array($0) }) { addresses.append(address) }
				case AF_INET6:
					var bytes = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
					if let address = IPAddress(bytes: withUnsafeBytes(of: &bytes) { Array($0) }) { addresses.append(address) }
				default: break
				}
			}
			cursor = info.pointee.ai_next
		}
		var seen: [IPAddress] = []
		for address in addresses where !seen.contains(address) { seen.append(address) }
		return seen
	}
}

/// One GET over Network.framework to a pinned address. Blocking: call it
/// off the main thread (RemotePdfStore's work queue does).
final class NetworkTransport: RemotePdfTransport {
	let scratchDir: URL

	init(scratchDir: URL) { self.scratchDir = scratchDir }

	func get(_ url: URL, at address: IPAddress, headers: [String: String], limit: Int) throws -> RemotePdfResponse {
		let exchange = try Exchange(url: url, address: address, headers: headers, limit: limit, scratchDir: scratchDir)
		return try exchange.run()
	}

	private final class Exchange {
		let url: URL
		let host: String
		let limit: Int
		let request: Data
		let connection: NWConnection
		let queue = DispatchQueue(label: "org.jmckalex.clew.remote-pdf.connection")
		let done = DispatchSemaphore(value: 0)
		let scratchDir: URL

		// Guarded by `queue`.
		var buffer = Data()
		var head: (status: Int, headers: [String: String])?
		var chunked: ChunkedDecoder?
		var contentLength: Int?
		var received = 0
		var prefix = Data()
		var file: FileHandle?
		var fileURL: URL?
		var outcome: Result<RemotePdfResponse, RemotePdfError>?

		init(url: URL, address: IPAddress, headers: [String: String], limit: Int, scratchDir: URL) throws {
			self.url = url
			self.host = url.host!
			self.limit = limit
			self.scratchDir = scratchDir
			let port = url.port ?? 443
			guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { throw RemotePdfError.badURL("port \(port)") }
			let nwHost: NWEndpoint.Host
			if address.isV4, let v4 = IPv4Address(Data(address.bytes)) { nwHost = .ipv4(v4) }
			else if let v6 = IPv6Address(Data(address.bytes)) { nwHost = .ipv6(v6) }
			else { throw RemotePdfError.network("unusable address \(address)") }

			// TLS names the ORIGINAL host: SNI, and the certificate is checked
			// against it, not against the IP the connection is pinned to.
			let tls = NWProtocolTLS.Options()
			let serverName = host
			sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, serverName)
			sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trustRef, complete in
				let trust = sec_trust_copy_ref(trustRef).takeRetainedValue()
				SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, serverName as CFString))
				var error: CFError?
				complete(SecTrustEvaluateWithError(trust, &error))
			}, DispatchQueue.global(qos: .userInitiated))
			let tcp = NWProtocolTCP.Options()
			tcp.connectionTimeout = Int(RemotePdfPolicy.connectTimeout)
			let parameters = NWParameters(tls: tls, tcp: tcp)
			// A proxy would resolve the host itself, around the pinned address.
			parameters.preferNoProxies = true
			connection = NWConnection(host: nwHost, port: nwPort, using: parameters)

			var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
			var target = components?.percentEncodedPath ?? "/"
			if target.isEmpty { target = "/" }
			if let query = components?.percentEncodedQuery { target += "?" + query }
			components = nil
			let hostHeader = (host.contains(":") ? "[\(host)]" : host) + (url.port.map { ":\($0)" } ?? "")
			var lines = ["GET \(target) HTTP/1.1", "Host: \(hostHeader)"]
			for (name, value) in headers.sorted(by: { $0.key < $1.key }) { lines.append("\(name): \(value)") }
			lines.append("Connection: close")
			request = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
		}

		func run() throws -> RemotePdfResponse {
			let started = Date()
			connection.stateUpdateHandler = { [weak self] state in
				guard let self else { return }
				switch state {
				case .ready:
					self.connection.send(content: self.request, completion: .contentProcessed { error in
						if let error { self.settle(.failure(.network(error.localizedDescription))) }
					})
					self.receive()
				case .waiting(let error):
					// Offline, or the address cannot be reached: fail fast rather
					// than wait for the path to come back.
					self.settle(.failure(.network(error.localizedDescription)))
				case .failed(let error):
					self.settle(.failure(.network(error.localizedDescription)))
				default: break
				}
			}
			connection.start(queue: queue)
			// Headers within 20 s of starting (the connect's own 10 s is in TCP).
			if done.wait(timeout: .now() + RemotePdfPolicy.headersTimeout) == .timedOut {
				let late = queue.sync { head == nil }
				if late { finishFromOutside(.failure(.headersTimeout)) }
				else {
					let remaining = RemotePdfPolicy.totalTimeout - Date().timeIntervalSince(started)
					if done.wait(timeout: .now() + max(0, remaining)) == .timedOut { finishFromOutside(.failure(.totalTimeout)) }
				}
			}
			connection.cancel()
			let final = queue.sync { outcome } ?? .failure(.network("no outcome"))
			switch final {
			case .success(let response): return response
			case .failure(let error):
				if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
				throw error
			}
		}

		/// On `queue` (every callback runs there): the first outcome wins.
		private func settle(_ result: Result<RemotePdfResponse, RemotePdfError>) {
			guard outcome == nil else { return }
			try? file?.close()
			file = nil
			outcome = result
			done.signal()
		}

		/// From the waiting thread (a timeout).
		private func finishFromOutside(_ result: Result<RemotePdfResponse, RemotePdfError>) {
			queue.sync { settle(result) }
		}

		private func receive() {
			connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
				guard let self else { return }
				do {
					if let data, !data.isEmpty { try self.consume(data) }
					if self.outcome != nil { return }
					if let error { throw RemotePdfError.network(error.localizedDescription) }
					if isComplete { try self.complete(); return }
					self.receive()
				} catch let error as RemotePdfError {
					self.settle(.failure(error))
				} catch {
					self.settle(.failure(.network(error.localizedDescription)))
				}
			}
		}

		// On `queue`.
		private func consume(_ data: Data) throws {
			if head == nil {
				buffer.append(data)
				guard let end = HTTPHead.headEnd(buffer) else {
					if buffer.count > 64 * 1024 { throw RemotePdfError.network("response head too long") }
					return
				}
				let headData = buffer.prefix(end - 4)
				let rest = buffer.suffix(from: buffer.startIndex + end)
				buffer = Data()
				head = try HTTPHead.parse(Data(headData))
				guard let head else { return }
				if head.status != 200 {
					// Only the status and headers matter (a redirect, an error).
					settle(.success(RemotePdfResponse(status: head.status, headers: head.headers, prefix: Data(), bodyFile: nil, bytes: 0)))
					return
				}
				if head.headers["transfer-encoding"]?.lowercased().contains("chunked") == true { chunked = ChunkedDecoder() }
				else if let length = head.headers["content-length"].flatMap(Int.init) {
					if length > limit { throw RemotePdfError.tooLarge(limit) }
					contentLength = length
				}
				let url = scratchDir.appendingPathComponent("fetch-\(UUID().uuidString).part")
				FileManager.default.createFile(atPath: url.path, contents: nil)
				fileURL = url
				file = try FileHandle(forWritingTo: url)
				try body(Data(rest))
			} else {
				try body(data)
			}
		}

		private func body(_ raw: Data) throws {
			var bytes = raw
			if chunked != nil { bytes = try chunked!.feed(raw) }
			if !bytes.isEmpty {
				received += bytes.count
				// Counted as it streams, never trusted from Content-Length.
				if received > limit { throw RemotePdfError.tooLarge(limit) }
				if prefix.count < 1024 { prefix.append(bytes.prefix(1024 - prefix.count)) }
				try file?.write(contentsOf: bytes)
			}
			if chunked?.done == true { try complete() }
			else if let contentLength, received >= contentLength { try complete() }
		}

		private func complete() throws {
			guard outcome == nil else { return }
			guard let head else { throw RemotePdfError.network("closed before any answer") }
			if let chunked, !chunked.done { throw RemotePdfError.network("closed mid-body") }
			if let contentLength, received < contentLength { throw RemotePdfError.network("closed mid-body") }
			settle(.success(RemotePdfResponse(status: head.status, headers: head.headers, prefix: prefix, bodyFile: fileURL, bytes: received)))
		}
	}
}
