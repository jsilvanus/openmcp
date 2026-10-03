# OpenMCP — six-step implementation plan

## Goal

Build OpenMCP as a reusable, standards-compliant MCP gateway that accepts an OpenAPI specification at runtime and exposes permitted API operations as dynamic MCP tools.

The project is a monorepo. STDIO is developed first as the local security boundary for desktop agents; HTTP comes later and reuses the same shared core.

## 1. Foundation + shared MCP core

Build the monorepo boundaries and transport-independent runtime.

- `packages/core`
- `packages/mcp`
- MCP server factory
- connection registry
- operation model
- common errors/logging
- TypeScript build/test setup

Success: the MCP server can be constructed independently of its eventual transport.

## 2. STDIO-first local server

Make OpenMCP a useful local MCP server for desktop agents.

- `packages/stdio`
- STDIO entry point
- local-only process model
- MCP Inspector testing
- compatibility testing with established desktop MCP clients

STDIO must not open a network listener. The desktop MCP client launches OpenMCP and communicates over stdin/stdout. This is a deliberate security boundary, not merely an MVP convenience.

## STDIO milestone acceptance

Before moving to runtime OpenAPI generation, the STDIO transport should satisfy:

- starts as a child process of an MCP client
- communicates exclusively through stdin/stdout for MCP traffic
- sends diagnostics only to stderr
- does not bind a TCP/HTTP listener
- exits non-zero on startup failure
- can be inspected with the MCP Inspector
- keeps the MCP server factory in the shared `mcp` package

## 3. Runtime OpenAPI → MCP engine

Implement the core purpose of OpenMCP without generating/deploying a new server per API.

- HTTPS OpenAPI loader
- OpenAPI 3.0/3.1 parsing
- normalized operation catalogue
- deterministic operation/tool names
- parameter and JSON-body schemas
- JSON Schema → MCP input schemas
- generic HTTP executor
- GET/POST first
- dynamic MCP tool registration
- API response/error mapping

Success: an OpenAPI URL produces usable MCP tools without source generation. **Implemented:** runtime OpenAPI 3.0/3.1 loading, GET/POST operation cataloguing, deterministic tool names, parameter/body schema conversion, generic HTTP execution, and dynamic MCP registration. Authentication, SSRF policy, refresh/replacement, and broader HTTP methods remain later steps.

## 4. Authentication + security policy

Add the security model for arbitrary APIs.

- API-key authentication
- per-user/per-connection credentials
- OAuth authorization-code + PKCE
- authorization-server discovery
- state validation and token refresh
- scopes
- encrypted credential storage
- read/mutating/destructive operation policy
- destructive-operation controls
- SSRF/network protections

Protect OpenAPI and target requests against localhost/private/link-local addresses, unsafe redirects, DNS rebinding, oversized documents, excessive timeouts, and credential leakage.

## 5. Dynamic lifecycle + semantic adapters

Make OpenMCP useful for long-lived connections and domain-specific APIs.

- specification hashing and refresh
- atomic catalogue replacement
- MCP tool-list change notifications
- multiple simultaneous API connections
- collision-safe names
- optional semantic adapter interface

PTV-MCP should become a useful migration experiment: generic OpenAPI wire-contract machinery belongs in OpenMCP; PTV terminology, transformations, workflows and other domain semantics stay in a small adapter.

## 6. HTTP transport + broad compatibility

Add the network transport only after the shared core and STDIO implementation are solid.

- Streamable HTTP MCP transport
- remote authentication
- TLS/deployment guidance
- session/multi-user handling
- rate limiting
- stronger remote audit/security controls

HTTP must reuse the same OpenAPI parser, operation registry, dynamic tool generation, API executor, authentication abstractions, policy engine, security components, and adapters.

The target is an MCP implementation usable as-is by compatible ChatGPT and Claude integrations, established desktop agents, and GUI applications, without client-specific OpenMCP code.

## End-state

```
openmcp/
  packages/
    core/       shared OpenAPI, execution, auth, policy
    mcp/        shared MCP server/tool layer
    stdio/      local desktop transport — first
    http/       remote transport — later
    adapters/   optional semantic adapters
```

The same logical API connection should expose the same logical tool set regardless of whether OpenMCP is reached through STDIO or HTTP.

## Explicit non-goals for the first implementation

- Do not generate and compile a new MCP server for every OpenAPI document.
- Do not make HTTP the first transport.
- Do not require Kubernetes.
- Do not put PTV-specific semantics into the generic executor.
- Do not expose arbitrary target URLs without SSRF/network controls.
