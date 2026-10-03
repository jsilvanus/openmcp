import type { OpenApiDocument, OperationDefinition, OpenApiParameter } from "./openapi.js";
import { AuthManager } from "./auth.js";
import { resolveSchema } from "./openapi.js";

export interface ExecuteResult {
  status: number;
  contentType?: string;
  body: unknown;
}

export async function executeOperation(
  operation: OperationDefinition,
  args: Record<string, unknown>,
  document: OpenApiDocument,
  connectionId?: string,
  auth = new AuthManager(),
): Promise<ExecuteResult> {
  let url = joinUrl(operation.baseUrl, operation.path);

  for (const parameter of operation.parameters) {
    if (parameter.in !== "path") continue;
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) throw new Error(`Missing required path parameter: ${parameter.name}`);
      continue;
    }
    url = url.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }

  const query = new URLSearchParams();
  const headers = new Headers({ accept: "application/json, text/plain;q=0.9, */*;q=0.8" });

  for (const parameter of operation.parameters) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.in !== "path" && parameter.required) {
        throw new Error(`Missing required ${parameter.in} parameter: ${parameter.name}`);
      }
      continue;
    }

    switch (parameter.in) {
      case "query":
        appendParameter(query, parameter, value);
        break;
      case "header":
        headers.set(parameter.name, String(value));
        break;
    }
  }

  if (connectionId) {
    const authHeaders = await auth.authorizationHeaders(connectionId);
    authHeaders.forEach((value, key) => headers.set(key, value));
    await auth.applyQueryCredential(connectionId, query);
  }

  const requestBody = operation.requestBody;
  const body = args.body;
  if (body !== undefined) {
    const jsonContent = requestBody?.content
      ? Object.entries(requestBody.content).find(([mediaType]) =>
          mediaType === "application/json" || mediaType.endsWith("+json"),
        )
      : undefined;

    if (!jsonContent) {
      throw new Error("This OpenAPI operation does not declare an application/json request body.");
    }

    headers.set("content-type", jsonContent[0]);
  }

  const queryString = query.toString();
  if (queryString) url += `?${queryString}`;

  const response = await fetch(url, {
    method: operation.method.toUpperCase(),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const contentType = response.headers.get("content-type") ?? undefined;
  const responseText = await response.text();
  let parsedBody: unknown = responseText;

  if (contentType?.includes("json") && responseText) {
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      // Preserve malformed JSON as text.
    }
  }

  if (!response.ok) {
    throw new Error(
      `API request failed: HTTP ${response.status} ${response.statusText}: ${formatBody(parsedBody)}`,
    );
  }

  return { status: response.status, contentType, body: parsedBody };
}

function appendParameter(query: URLSearchParams, parameter: OpenApiParameter, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) query.append(parameter.name, String(item));
    return;
  }
  query.set(parameter.name, String(value));
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, "") + (path.startsWith("/") ? "" : ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function formatBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 4000);
  try {
    return JSON.stringify(body).slice(0, 4000);
  } catch {
    return String(body);
  }
}
