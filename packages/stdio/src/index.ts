import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createOpenMcpServer } from "@openmcp/mcp";

void serveStdio(() => createOpenMcpServer());
console.error("OpenMCP STDIO server running.");