// VaultPaths: containment by real path (the symlink-escape fix). Temp
// directories only; run by scripts/test-swift.sh.
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL (line \(line)): \(name)") }
}

let fm = FileManager.default
// NSTemporaryDirectory is under /var/folders, a link to /private/var: the
// vault is addressed by its NON-canonical path throughout, as a bookmark
// made through a link would leave it.
let scratch = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("vault-paths-\(UUID().uuidString)")
let vault = scratch.appendingPathComponent("Vault")
let sub = vault.appendingPathComponent("sub")
try! fm.createDirectory(at: sub, withIntermediateDirectories: true)
try! "inside".write(to: sub.appendingPathComponent("real.md"), atomically: true, encoding: .utf8)
try! "secret".write(to: scratch.appendingPathComponent("outside.txt"), atomically: true, encoding: .utf8)
let link = { (name: String, dest: String) in try! fm.createSymbolicLink(atPath: vault.appendingPathComponent(name).path, withDestinationPath: dest) }
link("leak.md", "../outside.txt")                                   // a file link out
link("out", "..")                                                   // a folder link out
link("bibliography.bib", "/Users/nobody/Miscellaneous/Bib-minimal.bib") // a Mac path: dangles here
link("alias.md", "sub/real.md")                                     // a file link inside
link("docs", "sub")                                                 // a folder link inside

let root = VaultPaths.realPath(vault.path)!
check(root.hasPrefix("/private/"), "the root is canonical (/private/var), the vault was addressed via /var")
let at = { (rel: String) in VaultPaths.check(vault.appendingPathComponent(rel).path, root: root) }
let escapes = { (v: VaultPaths.Verdict) -> Bool in if case .escapes = v { return true }; return false }
let inside = { (v: VaultPaths.Verdict) -> Bool in if case .inside = v { return true }; return false }

check(inside(at("sub/real.md")), "a plain file inside")
check(inside(at("sub")), "a folder inside")
check(escapes(at("leak.md")), "a file link leaving the vault is refused")
check(at("leak.md") == .escapes(VaultPaths.realPath(scratch.appendingPathComponent("outside.txt").path)), "…with where it leads")
check(escapes(at("out")), "a folder link leaving the vault is refused")
check(escapes(at("out/outside.txt")), "…and every path through it")
check(inside(at("out/Vault/sub/real.md")), "a path out and back in reaches only vault content: allowed (the walk never lists it)")
check(at("bibliography.bib") == .escapes(nil), "a dangling link (a Mac path) is refused")
check(inside(at("alias.md")), "a file link inside the vault still works")
check(inside(at("docs/real.md")), "a folder link inside the vault still works")
check(at("sub/new.md") == .absent, "a new file in a real folder may be created")
check(at("new/deeper/note.md") == .absent, "…and in new folders under the vault")
check(escapes(at("out/new.md")), "a new file under a link leaving the vault may not")
check(at("missing.md") == .absent, "nothing there, inside: absent")
check(!VaultPaths.isInside(root + "2/x", root: root), "a sibling sharing the prefix is not inside")
check(VaultPaths.isInside(root, root: root + "/"), "the root itself, with or without a slash")
check(VaultPaths.isLink(vault.appendingPathComponent("leak.md").path) && !VaultPaths.isLink(sub.path), "isLink")

try? fm.removeItem(at: scratch)
print("VaultPaths: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
