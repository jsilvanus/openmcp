export { catalogueOperations, loadOpenApiDocument, resolveSchema } from "./openapi.js";
export type { HttpMethod, JsonSchema, OpenApiDocument, OpenApiOperation, OpenApiParameter, OperationDefinition } from "./openapi.js";
export { executeOperation } from "./executor.js";
export type { ExecuteResult } from "./executor.js";
export { AuthManager, CredentialStore } from "./auth.js";
export type { Credential } from "./auth.js";

export interface ApiConnection {
  id: string;
  openApiUrl: string;
  document: OpenApiDocument;
  operations: OperationDefinition[];
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ApiConnection>();
  add(connection: ApiConnection): void { this.connections.set(connection.id, connection); }
  get(id: string): ApiConnection | undefined { return this.connections.get(id); }
  list(): ApiConnection[] { return [...this.connections.values()]; }
}
