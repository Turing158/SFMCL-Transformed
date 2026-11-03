# Local UnRAR compatibility patch

This directory contains the published `unrar_sys` 0.5.8 source from
[muja/unrar.rs](https://github.com/muja/unrar.rs), with its original Rust bindings
and native UnRAR implementation. Cargo uses it through `[patch.crates-io]`.

The Rust bindings declare the static library API and callbacks as `extern "C"`,
while upstream UnRAR uses Windows `PASCAL`/`CALLBACK` (`stdcall`). Those conventions
have different symbol names and stack cleanup on x86. The local changes in
`vendor/unrar/dll.hpp` and `dll.cpp` use `UNRAR_RS_CALL` (`__cdecl` on Windows) for
the UnRAR API, callback types and definitions, so both sides use the C ABI.
Other Windows API calling conventions remain unchanged. x64's unified calling
convention and the Unix C ABI remain compatible.

Keep this change when updating the vendored library until upstream provides an
x86-compatible binding. Validate with the launcher's stored/encrypted RAR tests
on both `i686-pc-windows-msvc` and `x86_64-pc-windows-msvc`.

Rust binding licenses: `LICENSE-MIT` and `LICENSE-APACHE`.
Native UnRAR terms: `vendor/unrar/license.txt` and the repository's
`UNRAR-LICENSE.txt`.
