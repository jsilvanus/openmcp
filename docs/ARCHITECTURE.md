# OpenMCP architecture additions

## Monorepo and transport architecture

OpenMCP is intentionally a **monorepo**. The project will contain multiple MCP-facing transports built on a shared core:

```
openmcp/
  packages/
    core/             # shared OpenAPI, execution, policy, auth abstractions
    mcp/              # shared MCP protocol/tool layer
    stdio/            # local desktop/agent transport
    http/              # remote HTTP MCP transport
    adapters/         # optional domain-specific semantic adapters
```

The exact package names may evolve with the implementation, but the architectural boundary should remain clear.

The important rule is:

> **STDIO and HTTP are transports, not separate implementations of OpenMCP.**

They should share as much business logic as possible.

### Shared core

The shared components should include, as appropriate:

- OpenAPI loading and parsing
- OpenAPI normalization
- operation registry
- JSON Schema conversion
- dynamic MCP tool generation
- HTTP API execution
- authentication abstractions
- credential handling
- operation policy
- SSRF/network security
- connection management
- specification caching and refresh
- semantic adapter interfaces
- common logging/error handling

Transport-specific code should primarily deal with:

- connection lifecycle
- MCP transport
- transport authentication
- local versus remote security boundaries
- deployment/runtime concerns

Conceptually:

```
                 +----------------------+
                 |   OpenMCP shared     |
                 |       core           |
                 |                      |
                 | OpenAPI              |
                 | Operations           |
                 | Tools                |
                 | Auth                 |
                 | Policy               |
                 | Execution            |
                 +----------+-----------+
                            |
                +-----------+-----------+
                |                       |
                v                       v
          +-----------+           +-----------+
          |   STDIO   |           |   HTTP    |
          | transport |           | transport |
          +-----------+           +-----------+
                |                       |
                v                       v
          Desktop agents          Cloud/remote
          local GUI agents        agents / GUI
```

## STDIO first

**STDIO is the first transport to be developed.**

This is deliberate and is an important security feature, not merely an MVP convenience.

The STDIO implementation is intended to run locally on the user's own computer and communicate through the MCP client's local process interface.

This gives a strong initial security property:

> A locally installed OpenMCP STDIO server is available to the user's local desktop agent, but is not inherently exposed as a network service to a cloud-hosted agent.

The first release should therefore focus on:

```
Desktop MCP client
       |
       | STDIO
       v
   OpenMCP
       |
       v
   Target API
```

The local process can then use the user's network connection to reach the target API while the MCP interface itself remains local.

This is particularly valuable for APIs requiring user credentials: the initial architecture does not require exposing an OpenMCP HTTP endpoint to the Internet merely to make an API available to a desktop agent.

### STDIO security model

The STDIO transport should be treated as a security boundary.

It should:

- listen only through the MCP client's local process/stdin/stdout mechanism
- not open a listening network port
- keep credentials local to the user's machine where appropriate
- avoid unnecessarily exposing API tokens to a remote/cloud agent
- inherit the operating-system/user-level isolation of the desktop environment
- make explicit which configuration and credential stores are local

The exact security guarantees still depend on the desktop MCP client's process model and the user's machine, but avoiding a network listener is a meaningful reduction in attack surface.

## HTTP transport later

The HTTP implementation will be developed after the STDIO foundation.

It will expose the same OpenMCP capabilities through an HTTP MCP transport for environments where a network-accessible MCP server is appropriate.

Conceptually:

```
Cloud MCP client / remote agent
          |
          | HTTP MCP
          v
      OpenMCP HTTP
          |
          v
      Shared core
          |
          v
       Target API
```

The HTTP version therefore should **not fork the OpenAPI-to-MCP implementation**.

It should reuse the same shared operation registry, tool generation, authentication abstractions, policy engine, API executor, and security components.

HTTP introduces additional concerns that do not exist, or are substantially different, for local STDIO:

- remote MCP authentication
- TLS
- session handling
- CSRF considerations where applicable
- network access control
- rate limiting
- remote credential boundaries
- deployment isolation
- multi-user tenancy
- stronger audit requirements

These should be implemented in the HTTP transport layer or in explicitly shared security components where appropriate.

## ChatGPT, Claude, desktop agents, and GUI clients

The project goal is to produce a **standards-compliant, reusable MCP implementation** that can be used without OpenMCP-specific client modifications.

The intended compatibility target includes:

- ChatGPT MCP integrations where supported
- Claude MCP integrations where supported
- established desktop MCP agents
- other MCP-compatible agents
- GUI applications that embed or speak MCP

The key principle is:

> **OpenMCP should be usable as-is by a compatible MCP client.**

The project should therefore avoid client-specific protocol extensions in the core implementation.

Where clients differ in supported transports, authentication, dynamic tool updates, or UX, compatibility shims should remain isolated from the shared core.

### GUI as a possible client

A GUI can be built around the same OpenMCP core and/or MCP interface.

For example:

```
                 +------------------+
                 | GUI              |
                 | OpenMCP manager  |
                 +--------+---------+
                          |
                     shared core
                          |
             +------------+------------+
             |                         |
           STDIO                     HTTP
             |                         |
       local agent              remote agent
```

The GUI could eventually provide:

- adding an OpenAPI connection
- viewing discovered operations
- authentication/consent
- operation policy configuration
- connection status
- specification refresh
- credential management
- adapter selection

The GUI should not require a different OpenMCP execution engine.

## Architecture goal

The monorepo should converge on this model:

```
                         OpenMCP
                            |
                +-----------+-----------+
                |       Shared Core     |
                |                       |
                | OpenAPI -> Operations |
                | Operations -> MCP     |
                | HTTP execution        |
                | Auth                  |
                | Policy                |
                | Security              |
                | Adapters              |
                +-----------+-----------+
                            |
                 +----------+----------+
                 |                     |
              STDIO                  HTTP
                 |                     |
          local desktop          remote/cloud
              agents                agents
                 |
              optional
                 |
                GUI
```

**Development order:**

1. Shared core foundations
2. STDIO transport
3. Local security and credential handling
4. Desktop-agent compatibility testing
5. Dynamic OpenAPI/MCP functionality
6. HTTP transport
7. Remote authentication and multi-user hardening
8. Optional GUI

The transport split must remain an implementation detail from the perspective of OpenAPI semantics: the same API connection should produce the same logical tool set regardless of whether OpenMCP is reached through STDIO or HTTP.
