import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createOpenMcpServer } from "@openmcp/mcp";

async function main(): Promise<void> {
  const server = createOpenMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Never write diagnostics to stdout: stdout is the MCP protocol stream.
  console.error("OpenMCP STDIO server connected.");
}

main().catch((error: unknown) => {
  console.error("OpenMCP STDIO server failed.", error);
  process.exitCode = 1;
});