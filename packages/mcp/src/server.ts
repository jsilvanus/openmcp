import { McpServer } from "@modelcontextprotocol/server";
import {
  AuthManager,
  catalogueOperations,
  executeOperation,
  loadOpenApiDocument,
  type ApiConnection,
  type JsonSchema,
  type OpenApiDocument,
  type OperationDefinition,
  ConnectionRegistry,
} from "@openmcp/core";
import * as z from "zod/v4";

export function createOpenMcpServer(
  registry = new ConnectionRegistry(),
  auth = new AuthManager(),
): McpServer {
  const server = new McpServer({ name: "openmcp", version: "0.1.0" });

  // The only permanent API-management tool: load an OpenAPI contract and create
  // the corresponding runtime MCP tools.
  server.registerTool(
    "openmcp_connect_api",
    {
      description: "Load an OpenAPI 3.0/3.1 URL and dynamically create MCP tools for its supported GET and POST operations.",
      inputSchema: z.object({
        id: z.string().min(1),
        openApiUrl: z.url(),
      }),
    },
    async ({ id, openApiUrl }) => {
      try {
        const document = await loadOpenApiDocument(openApiUrl);
        const operations = catalogueOperations(document, id, openApiUrl);
        const connection: ApiConnection = { id, openApiUrl, document, operations };
        registry.add(connection);
        registerOperations(server, registry, auth, connection);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              connection: id,
              openApiUrl,
              openapi: document.openapi,
              tools: operations.map(operation => ({
                name: operation.name,
                operationId: operation.operationId,
                method: operation.method.toUpperCase(),
                path: operation.path,
              })),
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  // The second permanent tool owns the credential lifecycle. Target API tools
  // never receive raw credentials as arguments.
  server.registerTool(
    "openmcp_credentials",
    {
      description: "Manage authentication for an OpenMCP API connection: login with an API key or OAuth2, complete an OAuth login, check status, or logout.",
      inputSchema: z.object({
        action: z.enum(["login", "complete_oauth", "status", "logout"]),
        connectionId: z.string().min(1),
        method: z.enum(["apiKey", "oauth2"]).optional(),
        value: z.string().optional(),
        apiKeyName: z.string().optional(),
        apiKeyLocation: z.enum(["header", "query"]).optional(),
        clientId: z.string().optional(),
        redirectUri: z.url().optional(),
        scopes: z.array(z.string()).optional(),
        state: z.string().optional(),
        code: z.string().optional(),
      }),
    },
    async (input) => {
      try {
        if (input.action === "status") {
          return result(await auth.status(input.connectionId));
        }

        if (input.action === "logout") {
          return result({ loggedOut: await auth.logout(input.connectionId) });
        }

        const connection = registry.get(input.connectionId);
        if (!connection) throw new Error(`Unknown connection: ${input.connectionId}`);

        if (input.action === "complete_oauth") {
          if (!input.state || !input.code) throw new Error("state and code are required.");
          await auth.completeOAuth(input.connectionId, input.state, input.code);
          return result({ authenticated: true, method: "oauth2" });
        }

        if (input.method === "apiKey") {
          if (!input.value) throw new Error("value is required for API-key login.");
          const scheme = findApiKeyScheme(connection.document, input.apiKeyName, input.apiKeyLocation);
          if (!scheme) throw new Error("No matching OpenAPI apiKey security scheme was found.");
          await auth.setApiKey(input.connectionId, input.value, scheme);
          return result({ authenticated: true, method: "apiKey", location: scheme.in, name: scheme.name });
        }

        if (input.method === "oauth2") {
          if (!input.clientId || !input.redirectUri) {
            throw new Error("clientId and redirectUri are required for OAuth2 login.");
          }
          const login = await auth.beginOAuth(
            input.connectionId,
            connection.document,
            input.clientId,
            input.redirectUri,
            input.scopes,
          );
          return result({
            authenticated: false,
            method: "oauth2",
            state: login.state,
            authorizationUrl: login.authorizationUrl,
            next: "Open the authorizationUrl, authorize the application, then call openmcp_credentials with action=complete_oauth, the returned state, and the authorization code.",
          });
        }

        throw new Error("login requires method=apiKey or method=oauth2.");
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

function registerOperations(
  server: McpServer,
  registry: ConnectionRegistry,
  auth: AuthManager,
  connection: ApiConnection,
): void {
  for (const operation of connection.operations) {
    server.registerTool(
      operation.name,
      {
        description: operation.description,
        inputSchema: jsonSchemaToZod(operation.inputSchema, connection.document),
      },
      async (args) => {
        const current = registry.get(connection.id);
        if (!current) {
          return { content: [{ type: "text", text: `Connection "${connection.id}" no longer exists.` }], isError: true };
        }
        try {
          const result = await executeOperation(
            operation,
            args as Record<string, unknown>,
            current.document,
            current.id,
            auth,
          );
          return { content: [{ type: "text", text: formatResult(result.body) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      },
    );
  }
}

function findApiKeyScheme(
  document: OpenApiDocument,
  requestedName?: string,
  requestedLocation?: "header" | "query",
): { name: string; in: "header" | "query" } | undefined {
  const schemes = document.components?.securitySchemes as Record<string, unknown> | undefined;
  for (const scheme of Object.values(schemes ?? {})) {
    if (!scheme || typeof scheme !== "object") continue;
    const typed = scheme as { type?: string; name?: string; in?: string };
    if (
      typed.type === "apiKey" &&
      (typed.in === "header" || typed.in === "query") &&
      typed.name &&
      (!requestedName || typed.name === requestedName) &&
      (!requestedLocation || typed.in === requestedLocation)
    ) {
      return { name: typed.name, in: typed.in };
    }
  }
  return undefined;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function jsonSchemaToZod(schema: JsonSchema, document: OpenApiDocument): z.ZodTypeAny {
  if (schema.$ref) {
    const resolved = document.components?.schemas?.[schema.$ref.split("/").pop() ?? ""];
    if (resolved) return jsonSchemaToZod(resolved, document);
  }
  if (schema.enum) {
    if (schema.enum.length === 0) return z.never();
    if (schema.enum.every(value => typeof value === "string")) return z.enum(schema.enum as [string, ...string[]]);
    return z.union(schema.enum.map(value => z.literal(value)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  if (schema.const !== undefined) return z.literal(schema.const);
  if (schema.oneOf?.length) {
    const variants = schema.oneOf.map(item => jsonSchemaToZod(item, document));
    return variants.length === 1 ? variants[0] : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  if (schema.anyOf?.length) {
    const variants = schema.anyOf.map(item => jsonSchemaToZod(item, document));
    return variants.length === 1 ? variants[0] : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  switch (schema.type) {
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        const child = jsonSchemaToZod(property, document);
        shape[name] = schema.required?.includes(name) ? child : child.optional();
      }
      let objectSchema = z.object(shape);
      objectSchema = schema.additionalProperties === false ? objectSchema.strict() : objectSchema.passthrough();
      return schema.nullable ? objectSchema.nullable() : objectSchema;
    }
    case "array": {
      const arraySchema = z.array(jsonSchemaToZod(schema.items ?? {}, document));
      return schema.nullable ? arraySchema.nullable() : arraySchema;
    }
    case "integer": {
      const numberSchema = z.number().int();
      return schema.nullable ? numberSchema.nullable() : numberSchema;
    }
    case "number": {
      const numberSchema = z.number();
      return schema.nullable ? numberSchema.nullable() : numberSchema;
    }
    case "boolean": {
      const booleanSchema = z.boolean();
      return schema.nullable ? booleanSchema.nullable() : booleanSchema;
    }
    default: {
      const stringSchema = z.string();
      return schema.nullable ? stringSchema.nullable() : stringSchema;
    }
  }
}

function formatResult(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}
