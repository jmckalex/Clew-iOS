// Unit tests for ios/Clew/Sources/ColonConversion.swift — temp directories
// only. `npm run test:swift`.
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("colon-conversion-tests-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }
func put(_ url: URL, _ data: Data) {
	try! fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
	try! data.write(to: url)
}

// MARK: - The backup store: paths

let store = ColonBackupStore(root: scratch.appendingPathComponent("colon-conversion", isDirectory: true))
for bad in ["", "/etc/passwd", "..", "a/../b", "a//b", "./a", "a/.", "V/..", "a/\0b"] {
	check((try? store.url(bad)) == nil, "refused: \(bad.debugDescription)")
}
check((try? store.url("Demo Vault-0123456789ab/2026-10-11T10-00-00-000Z/notes/Sub/N.md"))?.path
	== store.root.appendingPathComponent("Demo Vault-0123456789ab/2026-10-11T10-00-00-000Z/notes/Sub/N.md").path,
	"a plain path lands inside the store")
check((try? store.write("../escape.md", data: Data("x".utf8))) == nil, "a write leaving the store is refused")
check(!fm.fileExists(atPath: scratch.appendingPathComponent("escape.md").path), "and nothing is written outside")

// MARK: - The backup store: writes, manifests, notes

let folder = "Demo Vault-0123456789ab"
let id = "2026-10-11T10-00-00-000Z"
let bom = Data([0xEF, 0xBB, 0xBF]) + Data("# BOM\r\n:::note\r\nx\r\n:::\r\n".utf8)
try! store.write("\(folder)/\(id)/notes/Sub/BOM.md", data: bom)
try! store.write("\(folder)/\(id)/notes/Top.md", data: Data(":today\n".utf8))
try! store.write("\(folder)/\(id)/manifest.json", data: Data("{\"id\":\"\(id)\"}".utf8))
let noteFile = store.root.appendingPathComponent("\(folder)/\(id)/notes/Sub/BOM.md")
check((try? Data(contentsOf: noteFile)) == bom, "bytes kept exactly (BOM, CRLF)")
check(!fm.fileExists(atPath: noteFile.deletingLastPathComponent().appendingPathComponent(".BOM.md.clew-tmp").path), "atomic: no temp left")
// A second conversion with no manifest yet, a dot entry, and another vault's.
try! fm.createDirectory(at: store.root.appendingPathComponent("\(folder)/2026-10-11T11-00-00-000Z/notes"), withIntermediateDirectories: true)
try! fm.createDirectory(at: store.root.appendingPathComponent("\(folder)/.DS_Store-dir"), withIntermediateDirectories: true)
try! store.write("Other-ffffffffffff/\(id)/manifest.json", data: Data("{}".utf8))
let manifests = try! store.manifests(folder: folder)
check(manifests == [id: "{\"id\":\"\(id)\"}"], "manifests: this vault's, only those with a manifest")
check((try? store.manifests(folder: "Missing-000000000000")) == [:], "no folder: no conversions")
check((try? store.manifests(folder: "../x")) == nil, "a folder leaving the store is refused")
var notes = try! store.notes(folder: folder, id: id, paths: ["Sub/BOM.md", "Top.md", "Missing.md"])
check(notes == ["Sub/BOM.md": bom, "Top.md": Data(":today\n".utf8)], "notes: those named, by vault path; a missing one left out")
check((try! store.notes(folder: folder, id: id, paths: ["Top.md"])) == ["Top.md": Data(":today\n".utf8)], "only those named")
check((try! store.notes(folder: folder, id: id, paths: ["../manifest.json", "../../Other-ffffffffffff/x", "/etc/passwd", ""])).isEmpty, "a path leaving the conversion's notes is left out")
// A link planted in a backup is not followed.
let outside = scratch.appendingPathComponent("secret.md")
put(outside, Data("secret".utf8))
try! fm.createSymbolicLink(at: store.root.appendingPathComponent("\(folder)/\(id)/notes/Link.md"), withDestinationURL: outside)
notes = try! store.notes(folder: folder, id: id, paths: ["Link.md", "Top.md"])
check(notes["Link.md"] == nil && notes.count == 1, "a link in the backup is not read")
check((try? store.notes(folder: folder, id: "..", paths: ["Top.md"])) == nil, "an id leaving the store is refused")

// MARK: - Folder configs

let vault = scratch.appendingPathComponent("Vault", isDirectory: true)
let realRoot = VaultPaths.realPath(vault.path) ?? vault.path
func config(_ rel: String, _ text: String) {
	put(vault.appendingPathComponent(rel).appendingPathComponent(".jmarkdown/config.json"), Data(text.utf8))
}
put(vault.appendingPathComponent("Note.md"), Data("x".utf8))
config("", "{\"Directives\":[\"root.js\"]}")
config("Loads/Folder", "{\"Directives\":[\"my.js\"]}")
config(".hidden", "{\"Directives\":[\"hidden.js\"]}")
config("node_modules/pkg", "{}")
put(vault.appendingPathComponent("Big/.jmarkdown/config.json"), Data(count: ColonVaultFiles.configCap + 1))
let realVault = VaultPaths.realPath(vault.path)!
let away = scratch.appendingPathComponent("Away", isDirectory: true)
put(away.appendingPathComponent(".jmarkdown/config.json"), Data("{\"Directives\":[\"away.js\"]}".utf8))
try! fm.createSymbolicLink(at: vault.appendingPathComponent("OutLink"), withDestinationURL: away)
try! fm.createSymbolicLink(at: vault.appendingPathComponent("InLink"), withDestinationURL: vault.appendingPathComponent("Loads"))
try! fm.createSymbolicLink(at: vault.appendingPathComponent("Loads/Up"), withDestinationURL: vault)
try! fm.createDirectory(at: vault.appendingPathComponent("Planted/.jmarkdown"), withIntermediateDirectories: true)
try! fm.createSymbolicLink(at: vault.appendingPathComponent("Planted/.jmarkdown/config.json"), withDestinationURL: away.appendingPathComponent(".jmarkdown/config.json"))
let configs = ColonVaultFiles.folderConfigs(root: vault, realRoot: realVault)
check(configs[""] == "{\"Directives\":[\"root.js\"]}", "the vault root's config")
check(configs["Loads/Folder"] == "{\"Directives\":[\"my.js\"]}", "a nested folder's config")
check(configs[".hidden"] == nil && configs["node_modules/pkg"] == nil, "dot-folders and node_modules are not walked, as the mirror")
check(configs["Big"] == nil, "a config over the cap is not read")
check(configs["OutLink"] == nil, "a folder link leaving the vault is not followed")
check(configs["Planted"] == nil, "a config that links out of the vault is refused")
check(configs["InLink/Folder"] == "{\"Directives\":[\"my.js\"]}", "a folder link inside the vault: found by the link's path too, as the mirror lists its notes")
check(Set(configs.keys) == ["", "Loads/Folder", "InLink/Folder"], "nothing else (a link back up the tree is not walked): \(configs.keys.sorted())")
_ = realRoot

// MARK: - Notes that are not UTF-8

put(vault.appendingPathComponent("Latin1.md"), Data([0x23, 0x20, 0xE9, 0x74, 0xE9, 0x0A]))
put(vault.appendingPathComponent("Empty.md"), Data())
put(vault.appendingPathComponent("BOM.md"), bom)
try! fm.createSymbolicLink(at: vault.appendingPathComponent("Escape.md"), withDestinationURL: away.appendingPathComponent(".jmarkdown/config.json"))
let raw = ColonVaultFiles.nonUTF8(root: vault, realRoot: realVault, rels: ["Latin1.md", "Empty.md", "BOM.md", "Escape.md", "Missing.md"])
check(raw == ["Latin1.md": Data([0x23, 0x20, 0xE9, 0x74, 0xE9, 0x0A])], "only the note that is not UTF-8, with its bytes: \(raw.keys.sorted())")

print("ColonConversion: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
