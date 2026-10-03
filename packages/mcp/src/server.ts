import { McpServer } from "@modelcontextprotocol/server";
import {
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
): McpServer {
  const server = new McpServer({
    name: "openmcp",
    version: "0.1.0",
  });

  server.registerTool(
    "openmcp_status",
    {
      description: "Return the current OpenMCP runtime status.",
    },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          server: "openmcp",
          version: "0.1.0",
          connections: registry.list().map(connection => ({
            id: connection.id,
            openApiUrl: connection.openApiUrl,
            operations: connection.operations.length,
          })),
          phase: "openapi-runtime",
        }),
      }],
    }),
  );

  server.registerTool(
    "openmcp_add_connection",
    {
      description: "Load an OpenAPI 3.0/3.1 document and expose its GET and POST operations as MCP tools.",
      inputSchema: z.object({
        id: z.string().min(1),
        openApiUrl: z.url(),
      }),
    },
    async ({ id, openApiUrl }) => {
      const document = await loadOpenApiDocument(openApiUrl);
      const operations = catalogueOperations(document, id, openApiUrl);
      const connection: ApiConnection = { id, openApiUrl, document, operations };

      registry.add(connection);
      registerOperations(server, registry, connection);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            connection: id,
            openApiUrl,
            openapi: document.openapi,
            operations: operations.map(operation => ({
              name: operation.name,
              operationId: operation.operationId,
              method: operation.method.toUpperCase(),
              path: operation.path,
            })),
          }),
        }],
      };
    },
  );

  return server;
}

function registerOperations(
  server: McpServer,
  registry: ConnectionRegistry,
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
          return {
            content: [{ type: "text", text: `Connection "${connection.id}" no longer exists.` }],
            isError: true,
          };
        }

        try {
          const result = await executeOperation(operation, args as Record<string, unknown>, current.document);
          return {
            content: [{
              type: "text",
              text: formatResult(result.body),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            }],
            isError: true,
          };
        }
      },
    );
  }
}

function jsonSchemaToZod(
  schema: JsonSchema,
  document: OpenApiDocument,
): z.ZodTypeAny {
  if (schema.$ref) {
    const resolved = document.components?.schemas?.[schema.$ref.split("/").pop() ?? ""];
    if (resolved) return jsonSchemaToZod(resolved, document);
  }

  if (schema.enum) {
    if (schema.enum.length === 0) return z.never();
    if (schema.enum.every(value => typeof value === "string")) {
      return z.enum(schema.enum as [string, ...string[]]);
    }
    return z.union(schema.enum.map(value => z.literal(value)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if (schema.const !== undefined) return z.literal(schema.const);

  if (schema.oneOf?.length) {
    const variants = schema.oneOf.map(item => jsonSchemaToZod(item, document));
    if (variants.length === 1) return variants[0];
    return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if (schema.anyOf?.length) {
    const variants = schema.anyOf.map(item => jsonSchemaToZod(item, document));
    if (variants.length === 1) return variants[0];
    return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  switch (schema.type) {
    case "object": {
      const properties = schema.properties ?? {};
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [name, property] of Object.entries(properties)) {
        const child = jsonSchemaToZod(property, document);
        shape[name] = schema.required?.includes(name) ? child : child.optional();
      }
      let objectSchema = z.object(shape);
      if (schema.additionalProperties === false) objectSchema = objectSchema.strict();
      else objectSchema = objectSchema.passthrough();
      return schema.nullable ? objectSchema.nullable() : objectSchema;
    }
    case "array": {
      const item = jsonSchemaToZod(schema.items ?? {}, document);
      const arraySchema = z.array(item);
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
    case "string":
    default: {
      const stringSchema = z.string();
      return schema.nullable ? stringSchema.nullable() : stringSchema;
    }
  }
}

function formatResult(body: unknown): string {
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}
