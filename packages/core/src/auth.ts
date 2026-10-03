import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenApiDocument } from "./openapi.js";

export type Credential =
  | { type: "apiKey"; value: string; location: "header" | "query"; name: string }
  | { type: "oauth2"; accessToken: string; refreshToken?: string; expiresAt?: number; tokenType?: string; clientId?: string; tokenUrl?: string };

interface StoredCredentials {
  version: 1;
  credentials: Record<string, Credential>;
}

interface PendingOAuth {
  connectionId: string;
  clientId: string;
  redirectUri: string;
  tokenUrl: string;
  verifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export class CredentialStore {
  private readonly filePath: string;
  private readonly keyPath: string;
  private cache?: StoredCredentials;

  constructor(
    filePath = process.env.OPENMCP_CREDENTIAL_FILE ?? join(homedir(), ".openmcp", "credentials.json.enc"),
    keyPath = process.env.OPENMCP_CREDENTIAL_KEY_FILE ?? join(homedir(), ".openmcp", "master.key"),
  ) {
    this.filePath = filePath;
    this.keyPath = keyPath;
  }

  async get(connectionId: string): Promise<Credential | undefined> {
    return (await this.load()).credentials[connectionId];
  }

  async set(connectionId: string, credential: Credential): Promise<void> {
    const data = await this.load();
    data.credentials[connectionId] = credential;
    await this.save(data);
  }

  async delete(connectionId: string): Promise<boolean> {
    const data = await this.load();
    const existed = connectionId in data.credentials;
    delete data.credentials[connectionId];
    if (existed) await this.save(data);
    return existed;
  }

  private async load(): Promise<StoredCredentials> {
    if (this.cache) return this.cache;
    try {
      const encrypted = await readFile(this.filePath, "utf8");
      const data = JSON.parse(decrypt(encrypted, await this.key())) as StoredCredentials;
      if (data.version !== 1 || !data.credentials) throw new Error("Invalid credential store.");
      this.cache = data;
      return data;
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code === "ENOENT") {
        this.cache = { version: 1, credentials: {} };
        return this.cache;
      }
      throw error;
    }
  }

  private async save(data: StoredCredentials): Promise<void> {
    const encrypted = encrypt(JSON.stringify(data), await this.key());
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
    this.cache = data;
  }

  private async key(): Promise<Buffer> {
    try {
      return await readFile(this.keyPath);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      await writeFile(this.keyPath, key, { mode: 0o600 });
      return key;
    }
  }
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(value => value.toString("base64url")).join(".");
}

function decrypt(encoded: string, key: Buffer): string {
  const [iv, tag, ciphertext] = encoded.split(".");
  if (!iv || !tag || !ciphertext) throw new Error("Invalid encrypted credential file.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export class AuthManager {
  private readonly pending = new Map<string, PendingOAuth>();

  constructor(private readonly store = new CredentialStore()) {}

  async status(connectionId: string): Promise<{ authenticated: boolean; type?: Credential["type"] }> {
    const credential = await this.store.get(connectionId);
    return credential ? { authenticated: true, type: credential.type } : { authenticated: false };
  }

  async logout(connectionId: string): Promise<boolean> {
    for (const [state, pending] of this.pending) {
      if (pending.connectionId === connectionId) this.pending.delete(state);
    }
    return this.store.delete(connectionId);
  }

  async setApiKey(
    connectionId: string,
    value: string,
    scheme: { name: string; in: "header" | "query" },
  ): Promise<void> {
    await this.store.set(connectionId, { type: "apiKey", value, location: scheme.in, name: scheme.name });
  }

  async beginOAuth(
    connectionId: string,
    document: OpenApiDocument,
    clientId: string,
    redirectUri: string,
    scopes?: string[],
  ): Promise<{ state: string; authorizationUrl: string }> {
    const flow = findAuthorizationCodeFlow(document);
    if (!flow) throw new Error("The OpenAPI document does not declare an OAuth2 authorization-code flow.");

    const verifier = randomBytes(32).toString("base64url");
    const challenge = await pkceChallenge(verifier);
    const state = randomBytes(24).toString("base64url");

    this.pending.set(state, {
      connectionId, clientId, redirectUri, tokenUrl: flow.tokenUrl, verifier, createdAt: Date.now(),
    });

    const url = new URL(flow.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (scopes?.length) url.searchParams.set("scope", scopes.join(" "));

    return { state, authorizationUrl: url.toString() };
  }

  async completeOAuth(connectionId: string, state: string, code: string): Promise<void> {
    const pending = this.pending.get(state);
    if (!pending || pending.connectionId !== connectionId) throw new Error("Unknown or mismatched OAuth state.");
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      this.pending.delete(state);
      throw new Error("OAuth login has expired. Start login again.");
    }

    const response = await fetch(pending.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OAuth token exchange failed: HTTP ${response.status}`);

    const token = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (!token.access_token) throw new Error("OAuth token response did not contain an access_token.");

    await this.store.set(connectionId, {
      type: "oauth2",
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    });
    this.pending.delete(state);
  }

  async refresh(connectionId: string): Promise<boolean> {
    const credential = await this.store.get(connectionId);
    if (!credential?.refreshToken || !credential.clientId || !credential.tokenUrl) return false;

    const response = await fetch(credential.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: credential.clientId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OAuth token refresh failed: HTTP ${response.status}`);

    const token = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (!token.access_token) throw new Error("OAuth refresh response did not contain an access_token.");

    await this.store.set(connectionId, {
      type: "oauth2",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? credential.refreshToken,
      tokenType: token.token_type ?? credential.tokenType,
      expiresAt: token.expires_in !== undefined ? Date.now() + token.expires_in * 1000 : credential.expiresAt,
      clientId: credential.clientId,
      tokenUrl: credential.tokenUrl,
    });
    return true;
  }

  async authorizationHeaders(connectionId: string): Promise<Headers> {
    const headers = new Headers();
    const credential = await this.store.get(connectionId);
    if (!credential) return headers;
    if (credential.type === "oauth2") {
      headers.set("authorization", `${credential.tokenType ?? "Bearer"} ${credential.accessToken}`);
    } else if (credential.location === "header") {
      headers.set(credential.name, credential.value);
    }
    return headers;
  }

  async applyQueryCredential(connectionId: string, query: URLSearchParams): Promise<void> {
    const credential = await this.store.get(connectionId);
    if (credential?.type === "apiKey" && credential.location === "query") {
      query.set(credential.name, credential.value);
    }
  }
}

function findAuthorizationCodeFlow(document: OpenApiDocument): { authorizationUrl: string; tokenUrl: string } | undefined {
  const schemes = document.components?.securitySchemes as Record<string, unknown> | undefined;
  for (const scheme of Object.values(schemes ?? {})) {
    if (!scheme || typeof scheme !== "object") continue;
    const typed = scheme as { type?: string; flows?: { authorizationCode?: { authorizationUrl?: string; tokenUrl?: string } } };
    const flow = typed.flows?.authorizationCode;
    if (typed.type === "oauth2" && flow?.authorizationUrl && flow.tokenUrl) {
      return { authorizationUrl: flow.authorizationUrl, tokenUrl: flow.tokenUrl };
    }
  }
  return undefined;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("base64url");
}
