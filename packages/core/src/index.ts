export interface ApiConnection {
  id: string;
  openApiUrl: string;
}

export interface OperationDefinition {
  name: string;
  method: string;
  path: string;
  description?: string;
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ApiConnection>();

  add(connection: ApiConnection): void {
    this.connections.set(connection.id, connection);
  }

  list(): ApiConnection[] {
    return [...this.connections.values()];
  }
}
