# openmcp

OpenMCP is a runtime OpenAPI → MCP gateway.

It is a monorepo with a shared core and multiple transports:

- **STDIO** — first transport; local desktop-agent boundary
- **MCP** — shared server/tool layer
- **HTTP** — later remote transport using the same core

The long-term goal is to let a compatible MCP client connect to one OpenMCP server, provide an OpenAPI specification, and receive the permitted API operations as dynamic MCP tools. OpenMCP interprets the contract at runtime rather than generating and deploying a separate MCP server.

## Current scaffold

```
packages/
  core/       shared runtime state and domain abstractions
  mcp/        MCP server factory and tools
  stdio/      local STDIO entry point
```

The current scaffold exposes:

- `openmcp_status`
- `openmcp_add_connection`

Dynamic OpenAPI parsing and generated tools are the next implementation step.

## Run

Install dependencies:

```bash
npm install
```

Run the STDIO server:

```bash
npm run dev:stdio
```

Inspect it with the MCP Inspector:

```bash
npm run inspect:stdio
```

STDIO writes protocol data to stdout; diagnostics go to stderr.

## Architecture

See:

- `docs/ARCHITECTURE.md`
- `docs/PLAN.md`
- `docs/IMPLEMENTATION_PLAN.md`

The six-step implementation sequence is:

1. Foundation + shared MCP core
2. STDIO-first local server
3. Runtime OpenAPI → MCP engine
4. Authentication + security policy
5. Dynamic lifecycle + semantic adapters
6. HTTP transport + broad compatibility

HTTP is intentionally later. The shared core must remain transport-independent so the same logical API connection produces the same logical MCP tools over STDIO or HTTP.
