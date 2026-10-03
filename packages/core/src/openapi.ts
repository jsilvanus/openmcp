import { parse as parseYaml } from "yaml";

export type HttpMethod = "get" | "post";

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  [key: string]: unknown;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  example?: unknown;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema; example?: unknown }>;
  };
}

export interface OpenApiDocument {
  openapi: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation | Record<string, unknown>>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, unknown>;
  };
}

export interface OperationDefinition {
  name: string;
  operationId: string;
  method: HttpMethod;
  path: string;
  description: string;
  baseUrl: string;
  parameters: OpenApiParameter[];
  requestBody?: OpenApiOperation["requestBody"];
  inputSchema: JsonSchema;
}

const HTTP_METHODS: HttpMethod[] = ["get", "post"];
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export async function loadOpenApiDocument(url: string): Promise<OpenApiDocument> {
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("OpenAPI URL must use HTTP or HTTPS.");
  }

  const response = await fetch(parsedUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json, application/yaml, text/yaml, text/plain;q=0.8" },
  });

  if (!response.ok) {
    throw new Error(`Failed to load OpenAPI document: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DOCUMENT_BYTES) {
    throw new Error("OpenAPI document exceeds the 5 MiB limit.");
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("OpenAPI document exceeds the 5 MiB limit.");
  }

  const text = new TextDecoder().decode(buffer);
  const document = parseYaml(text) as OpenApiDocument;

  if (!document || typeof document !== "object" || typeof document.openapi !== "string") {
    throw new Error("The loaded document is not an OpenAPI document.");
  }

  if (!document.openapi.startsWith("3.0.") && !document.openapi.startsWith("3.1.")) {
    throw new Error(`Unsupported OpenAPI version: ${document.openapi}. OpenMCP currently supports OpenAPI 3.0 and 3.1.`);
  }

  if (!document.paths || typeof document.paths !== "object") {
    throw new Error("OpenAPI document has no paths.");
  }

  return document;
}

export function catalogueOperations(
  document: OpenApiDocument,
  connectionId: string,
  documentUrl: string,
): OperationDefinition[] {
  const baseUrl = resolveBaseUrl(document, documentUrl);
  const result: OperationDefinition[] = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    const pathParameters = Array.isArray((pathItem as Record<string, unknown>).parameters)
      ? ((pathItem as Record<string, unknown>).parameters as OpenApiParameter[])
      : [];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;

      const typedOperation = operation as OpenApiOperation;
      const parameters = mergeParameters(pathParameters, typedOperation.parameters ?? []);
      const operationId = typedOperation.operationId ?? fallbackOperationId(method, path);
      const name = uniqueToolName(connectionId, operationId, method, path);
      const description =
        typedOperation.summary ??
        typedOperation.description ??
        `${method.toUpperCase()} ${path}`;

      result.push({
        name,
        operationId,
        method,
        path,
        description,
        baseUrl,
        parameters,
        requestBody: typedOperation.requestBody,
        inputSchema: buildInputSchema(parameters, typedOperation.requestBody),
      });
    }
  }

  return result;
}

function resolveBaseUrl(document: OpenApiDocument, documentUrl: string): string {
  const serverUrl = document.servers?.[0]?.url;
  if (serverUrl) return new URL(serverUrl, documentUrl).toString().replace(/\/$/, "");
  return new URL(documentUrl).origin;
}

function mergeParameters(
  pathParameters: OpenApiParameter[],
  operationParameters: OpenApiParameter[],
): OpenApiParameter[] {
  const merged = new Map<string, OpenApiParameter>();
  for (const parameter of pathParameters) merged.set(`${parameter.in}:${parameter.name}`, parameter);
  for (const parameter of operationParameters) merged.set(`${parameter.in}:${parameter.name}`, parameter);
  return [...merged.values()];
}

function fallbackOperationId(method: HttpMethod, path: string): string {
  const cleaned = path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map(part => part.replace(/[^A-Za-z0-9]+/g, "_"))
    .filter(Boolean)
    .join("_");
  return `${method}_${cleaned || "root"}`;
}

function uniqueToolName(
  connectionId: string,
  operationId: string,
  method: HttpMethod,
  path: string,
): string {
  const sanitize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");

  const base = sanitize(operationId) || fallbackOperationId(method, path);
  return `${sanitize(connectionId)}__${base}`;
}

function buildInputSchema(
  parameters: OpenApiParameter[],
  requestBody?: OpenApiOperation["requestBody"],
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const parameter of parameters) {
    if (parameter.in === "cookie") continue;
    properties[parameter.name] = {
      ...(parameter.schema ?? { type: "string" }),
      description: parameter.description ?? parameter.schema?.description,
    };
    if (parameter.required) required.push(parameter.name);
  }

  const jsonContent = requestBody?.content
    ? Object.entries(requestBody.content).find(([mediaType]) =>
        mediaType === "application/json" || mediaType.endsWith("+json"),
      )?.[1]
    : undefined;

  if (jsonContent?.schema) {
    properties.body = jsonContent.schema;
    if (requestBody?.required) required.push("body");
  }

  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

export function resolveSchema(
  schema: JsonSchema | undefined,
  document: OpenApiDocument,
): JsonSchema | undefined {
  if (!schema?.$ref) return schema;
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) {
    throw new Error(`Unsupported schema reference: ${schema.$ref}`);
  }
  return document.components?.schemas?.[schema.$ref.slice(prefix.length)];
}
