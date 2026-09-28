# Native filesystem bridge

`@rae/fs-bridge` exposes the descriptor-relative filesystem operations used by
RAE's TypeScript transactions. Transaction policy, validation, journals and
recovery remain in their owning packages.

Build from a prepared repository checkout with Node.js 24 or newer, CMake and
a C compiler:

```text
npm --workspace @rae/fs-bridge run build
```

CMake.js builds the C Node-API module without a Python build dependency. The
TypeScript package loads the compiled module lazily. A missing module or an
unsupported native operation throws; there is no path-based fallback.

## Operations and boundaries

`openRoot` walks every absolute directory component without following links.
Callers must supply the intended canonical root; `/tmp` and `/var` aliases on
macOS are symlinks and are rejected. `openParent` and the `*At` operations work
relative to an already-open directory descriptor. Raw `Buffer` names preserve
non-UTF8 filesystem names on systems that support them.

File opens reject symlinks and non-regular files. Ordinary opens also reject
hardlinks. `openLinkedFileAt` is an explicit read-only exception for aliases
owned by a transaction. Callers must close every returned descriptor.

`renameAt` uses `renameatx_np(RENAME_EXCL)` on macOS and
`renameat2(RENAME_NOREPLACE)` on Linux for atomic no-clobber moves. Existing
destinations remain intact. The source and destination parent directories
must permit namespace writes; changing live permissions is not part of the
bridge. Replacing a child under a read-only parent requires the transaction to
stage and validate an appropriate ancestor instead. On macOS, read-only
directories cannot move across parents; sibling staging and backup names allow
same-parent renames without changing the live directory mode.

The bridge does not authorize callers, choose transaction roots, interpret
journal contents or make a series of operations atomic. Owners must validate
root identity and file ownership, retain concurrent-change evidence, and
synchronize file and directory descriptors where crash durability is required.

macOS and Linux are the supported build targets. Linux kernels or filesystems
without the required no-clobber operation fail closed. The native tests cover
symlink traversal, parent replacement, no-clobber behavior, hardlink handling
and invalid descriptor arguments; running them on one operating system does
not verify the other.
