import { McpServer } from "@modelcontextprotocol/server";
import { ConnectionRegistry } from "@openmcp/core";
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
          connections: registry.list().length,
          phase: "scaffold",
        }),
      }],
    }),
  );

  server.registerTool(
    "openmcp_add_connection",
    {
      description: "Register an OpenAPI URL as an OpenMCP connection. OpenAPI parsing is implemented in a later phase.",
      inputSchema: z.object({
        id: z.string().min(1),
        openApiUrl: z.url(),
      }),
    },
    async ({ id, openApiUrl }) => {
      registry.add({ id, openApiUrl });
      return {
        content: [{
          type: "text",
          text: `Registered connection "${id}" for ${openApiUrl}. Dynamic OpenAPI tool generation is the next implementation step.`,
        }],
      };
    },
  );

  return server;
}
