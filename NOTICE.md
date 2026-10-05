# Attribution and modifications

Recordly MCP Server is an independent, unofficial compatibility tool. It is not the
Recordly desktop application and is not endorsed by its authors. Recordly is
referenced only to identify the software this tool interoperates with.

Source basis: [DharambirAgrawal/clip-agent](https://github.com/DharambirAgrawal/clip-agent),
`mcp-server/` at commit `703ec66fa8740537aefcd20ff04e1e8b68c9f35f`.
ClipAgent is derived from [Recordly by webadderall](https://github.com/webadderallorg/Recordly),
which originated from OpenScreen by Siddharth Vaddem.

The upstream `LICENSE.md` is preserved verbatim, including the AGPLv3 text,
Recordly notices and original MIT attribution. See that file for full terms.

Modifications published 2026-10-05:

- Existing-zoom listing, partial updates, selective deletion, revision checks,
  exact backups and write serialization.
- Default Recordly/custom-recordings directory resolution and exclusive project
  copies in the desktop-visible Projects folder.
- Guarded source-time clip subtraction for the tested Recordly 1.4.0 model,
  per-clip audio setting propagation and output-time mapping.
- Reduced MCP surface excluding incompatible legacy trim and approximate export.
- MCP documentation and synthetic integration tests.

The distributed repository contains no desktop binaries, private recordings,
personal project files, transcripts, credentials, or user-specific configurations.
