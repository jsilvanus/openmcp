# OpenMCP implementation plan

## Goal

OpenMCP is a single, permanent MCP server that dynamically turns a user-selected OpenAPI specification into MCP tools at runtime. It should not generate and deploy a separate MCP server for every API.

Architecture:

    MCP client
        | MCP
        v
    OpenMCP
      |-- MCP server / dynamic tool registry
      |-- OpenAPI loader/parser
      |-- authentication manager
      |-- HTTP executor
      |-- security and policy layer
        |
        v
    Target API

## Core principles

### One server, dynamic tools

The OpenMCP process remains the same while its available tools change according to the user's API connections. When an OpenAPI specification changes, OpenMCP reparses it and refreshes the tool catalogue, using MCP's tool-list change mechanism where supported.

### Runtime interpretation, not source generation

Do not initially generate TypeScript/JavaScript source, compile it, and deploy it. Parse the OpenAPI document into an internal representation and use that representation to construct MCP tools dynamically.

Each normalized operation should contain at least:
- operation ID
- HTTP method and path
- description
- path/query/header parameters
- request-body schema
- response information
- security requirements

An MCP call resolves an operation, validates arguments, builds the HTTP request, applies credentials, executes it, and maps the response back to MCP.

### Generic plumbing versus semantic adapters

OpenMCP should provide generic OpenAPI-to-MCP plumbing. Domain-specific adapters may add better semantics, descriptions, transformations, validation, or workflows.

This is especially relevant to PTV-MCP: generic wire-contract work should eventually live in OpenMCP, while PTV-specific semantics remain in a small adapter.

## User flow

1. User connects their MCP client to OpenMCP.
2. User supplies an OpenAPI URL.
3. OpenMCP validates and loads the specification.
4. OpenMCP discovers operations and security requirements.
5. OpenMCP exposes permitted operations as MCP tools.
6. If authentication is required, OpenMCP starts the target API's authentication flow.
7. User completes login/consent.
8. OpenMCP stores credentials securely for that user's API connection.
9. MCP tool calls become authenticated API requests.
10. Specification changes can refresh the tool catalogue without redeployment.

Example tool naming:

    <connection>__<operationId>

so an operation named getService on a PTV connection could become:

    ptv__getService

## Authentication

There are two separate authentication relationships:

1. MCP client -> OpenMCP: authenticates the user to OpenMCP.
2. OpenMCP -> target API: establishes that user's credential for the target API.

For OAuth APIs, the intended flow is authorization-code OAuth with PKCE, with authorization-server discovery, state validation, secure callback handling, token refresh, and scopes.

Target credentials must be scoped to the individual user and API connection. Never use one global access token for all users.

Implementation order:
1. unauthenticated APIs
2. API keys
3. OAuth authorization code + PKCE
4. refresh tokens
5. multiple credential types and scopes

Reuse the relevant MCP SDK/protocol authentication facilities instead of inventing a parallel protocol.

## OpenAPI support

MVP support:
- OpenAPI 3.0
- OpenAPI 3.1
- JSON specifications
- HTTPS specification URLs
- operationId
- GET and POST
- path/query/header parameters
- JSON request bodies
- JSON Schema-derived MCP input schemas
- JSON responses

Later support can add PUT, PATCH, DELETE, multipart/form data, non-JSON responses, pagination, links, and other OpenAPI features.

## Dynamic tool generation

For every permitted operation, create an MCP tool dynamically. Tool schemas should be derived from OpenAPI parameters and request-body schemas.

The tool handler must remain generic:

    callTool(name, arguments)
      -> resolve connection
      -> resolve operation
      -> validate arguments
      -> construct URL/headers/body
      -> apply credentials
      -> execute HTTP request
      -> map result to MCP

No PTV-specific logic should be required by the generic executor.

## Security boundary

Loading arbitrary OpenAPI URLs creates an SSRF risk. The loader must protect against internal destinations and unsafe redirects.

At minimum:
- require HTTPS by default
- reject localhost and loopback
- reject link-local and private IPv4/IPv6 ranges
- validate redirects
- protect against DNS rebinding
- enforce timeouts
- enforce maximum specification size
- validate content type
- limit redirects
- never leak credentials to specification hosts

Target API requests need equivalent URL and network restrictions. OpenMCP must not become an unrestricted server-side HTTP proxy.

## Operation policy

Do not blindly expose every OpenAPI operation. APIs may contain administrative or destructive endpoints.

Introduce a policy layer between parsed operations and MCP tools. Initial categories:
- read-only
- mutating
- destructive

Example policy:

    allow: GET
    confirmation: POST, PUT, PATCH
    deny: DELETE

Policy must be enforced by OpenMCP itself, not delegated to the LLM.

Future policies can include operation allow/deny lists, scopes, host restrictions, confirmation requirements, rate limits, and request-size limits.

## Credential storage

Keep connection metadata separate from secrets. A connection should record its OpenAPI URL, specification hash, OAuth issuer/client information, scopes, and encrypted credentials.

Tokens must be encrypted at rest and must never appear in tool descriptions, arguments, logs, errors, OpenAPI documents, or source control.

## Specification lifecycle

Store:
- specification URL
- specification hash
- OpenAPI version
- normalized operation catalogue
- last successful refresh
- authentication configuration

Refresh flow:

    download -> validate -> hash
       -> unchanged: no-op
       -> changed: parse -> policy -> rebuild tools -> notify client

Never replace a known-good catalogue with a broken specification.

## Suggested component structure

    src/
      mcp/
      openapi/
      execution/
      auth/
      policy/
      connections/
      security/

Likely responsibilities:
- mcp: server, transport, dynamic tools
- openapi: loading, parsing, normalization, schema conversion
- execution: request building, HTTP, response mapping
- auth: MCP auth, API keys, OAuth, token storage
- policy: operation evaluation
- connections: connection and specification state
- security: URL validation, SSRF protection, secret redaction

## Implementation phases

### Phase 0 - foundation
- establish TypeScript/runtime conventions
- choose MCP SDK
- choose HTTP client
- establish tests
- define configuration
- document transport

### Phase 1 - static OpenAPI to MCP

Implement unauthenticated GET/POST APIs, schema conversion, request execution, error handling, and local mock-API tests.

Success criterion: an OpenAPI URL produces usable dynamic MCP tools and those tools successfully call a mock API.

### Phase 2 - API connections

Introduce connection IDs so multiple APIs can coexist for one user. Each connection owns its specification, policy, credentials, and tool namespace.

### Phase 3 - API keys

Implement OpenAPI API-key security schemes and secure per-user storage.

### Phase 4 - OAuth

Implement discovery, authorization-code flow, PKCE, callback handling, state validation, token storage, refresh, and scopes.

### Phase 5 - dynamic refresh

Implement specification hashing, refresh, atomic catalogue replacement, and tools/listChanged.

### Phase 6 - policy and hardening

Implement SSRF protection, operation policies, destructive-operation controls, rate limits, request/response limits, secret redaction, and audit logging without secrets.

### Phase 7 - semantic adapters

Define an optional adapter interface that can override names/descriptions and add transformations or workflows while leaving generic OpenAPI plumbing in OpenMCP.

## PTV-MCP migration experiment

Use PTV-MCP as the first serious integration test.

Move these generic concerns toward OpenMCP:
- OpenAPI parsing
- operation discovery
- MCP tool definitions
- JSON Schema conversion
- HTTP request construction
- authentication/OAuth
- generic error handling
- dynamic tool updates

Keep these concerns in the PTV adapter:
- terminology
- semantic descriptions
- domain-specific transformations
- multi-request workflows
- PTV-specific validation
- usability improvements that cannot be represented by OpenAPI

Target architecture:

    PTV-MCP = OpenMCP generic runtime + small PTV semantic adapter

## Testing

Unit-test parsing, normalization, naming, schema conversion, URL construction, parameter encoding, authentication, policy, and SSRF protection.

Integration-test a local mock API with public, API-key, and OAuth endpoints; GET/POST/PATCH/DELETE; malformed responses; redirects; and changing OpenAPI documents.

Security-test localhost, private IPs, IPv6 local addresses, DNS rebinding, redirect-to-private-address, oversized documents/responses, credential leakage, malicious descriptions, and malformed schemas.

## Deployment

OpenMCP should initially be a normal long-running service. Docker or Podman is sufficient for the first deployment. Kubernetes is not required for the MVP.

The important property is that adding an API does not require a new deployment.

Conceptually:

    Docker/Podman
        |
      OpenMCP
        +-- Postgres
        +-- secret storage
        +-- HTTPS reverse proxy

## Definition of done for the first useful release

1. User connects one MCP server: OpenMCP.
2. User supplies an HTTPS OpenAPI URL.
3. OpenMCP validates and loads it.
4. Permitted operations become dynamic MCP tools.
5. GET and POST JSON APIs work.
6. API-key authentication works securely.
7. Multiple API connections coexist.
8. Tool names are deterministic and collision-safe.
9. Arbitrary target URLs are protected against SSRF.
10. A changed specification can update the tool catalogue without redeploying OpenMCP.

OAuth should follow as the next major milestone.

## Architectural north star

OpenMCP should turn an OpenAPI contract into an MCP interface at runtime while keeping authentication, security policy, and domain-specific semantics as explicit layers.

    MCP client
        |
        | one MCP connection
        v
    +----------------+
    |    OpenMCP     |
    +----------------+
      /      |      \
     /       |       \
 OpenAPI    Auth    Policy
  engine    engine   engine
     \       |       /
      +------+-------+
             |
             v
        Target APIs
