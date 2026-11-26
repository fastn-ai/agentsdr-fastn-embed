import "server-only";
import { createHmac } from "node:crypto";

/**
 * Fastn embeds third-party app integrations (HubSpot, Slack, …) in AgentSDR.
 * One Fastn account serves every organization on this deployment, and each
 * AgentSDR organization is its own Fastn customer with its own connections.
 *
 * Two server-side calls, both signed with the key's identity secret:
 * - POST /v1/orgs registers an organization as a Fastn customer (once).
 * - POST /v1/embed/token mints a short-lived token for that customer's widget.
 *
 * FASTN_API_KEY and FASTN_IDENTITY_SECRET never reach the browser.
 */

export function fastnConfigured(): boolean {
  return Boolean(process.env.FASTN_API_KEY && process.env.FASTN_IDENTITY_SECRET);
}

/** The Fastn deployment the widget loads from. Same origin the token is minted on. */
export function fastnBaseUrl(): string {
  return (process.env.FASTN_BASE_URL || "https://api.fastn.dev").replace(/\/$/, "");
}

export class FastnError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Hex HMAC-SHA256 of `<orgId>\n<userId>`, signed with the key's identity secret. */
function identityHmac(orgId: string, userId: string): string {
  return createHmac("sha256", process.env.FASTN_IDENTITY_SECRET ?? "")
    .update(`${orgId}\n${userId}`)
    .digest("hex");
}

type Identity = { orgId?: string; userId: string };

async function fastnRequest(method: "GET" | "POST", path: string, identity: Identity, body?: unknown) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${process.env.FASTN_API_KEY}`,
    "x-user-id": identity.userId,
    // Acting as AgentSDR itself (no customer named): sign an empty org id.
    "x-identity-hmac": identityHmac(identity.orgId ?? "", identity.userId),
  };
  if (identity.orgId) headers["x-org-id"] = identity.orgId;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${fastnBaseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string; code?: string };
  if (!res.ok) throw new FastnError(json.error ?? `Fastn answered HTTP ${res.status}`, res.status, json.code);
  return json.data;
}

/** Registers an AgentSDR organization as a Fastn customer, under its own id. Safe to repeat. */
async function registerCustomer(customer: { orgId: string; name: string; userId: string }): Promise<void> {
  try {
    await fastnRequest("POST", "/v1/orgs", { userId: customer.userId }, { name: customer.name, orgId: customer.orgId });
  } catch (error) {
    // Fastn refuses a second registration of the same id; that is the state we want.
    if (error instanceof FastnError && error.status === 400 && /already used/i.test(error.message)) return;
    throw error;
  }
}

/**
 * AgentSDR is itself a connector in Fastn (it sends lead events). Each customer
 * needs a connection to it, with no credentials, so that the integrations they
 * turn on can listen to AgentSDR's events. Customers never see this step. Fastn
 * upserts by name, so repeating it is harmless.
 */
const productConnected = new Set<string>();

async function ensureProductConnection(customer: { orgId: string; userId: string }): Promise<void> {
  const connectorId = process.env.FASTN_PRODUCT_CONNECTOR_ID;
  const authMethodId = process.env.FASTN_PRODUCT_AUTH_METHOD_ID;
  if (!connectorId || !authMethodId || productConnected.has(customer.orgId)) return;
  await fastnRequest("POST", "/api/v1/connections", customer, {
    connectorId,
    authMethodId,
    authType: "NO_AUTH",
    name: "default",
    orgId: customer.orgId,
    // Fastn refuses an empty credentials object; the org id is not a secret.
    credentials: { organizationId: customer.orgId },
  });
  productConnected.add(customer.orgId);
}

/**
 * A widget token for one organization and the person signed in to it. The
 * organization is registered with Fastn, and connected to AgentSDR's own
 * connector, the first time it asks.
 */
export async function mintEmbedToken(customer: { orgId: string; name: string; userId: string }): Promise<string> {
  const mint = () => fastnRequest("POST", "/v1/embed/token", customer) as Promise<{ token: string }>;
  let token: string;
  try {
    token = (await mint()).token;
  } catch (error) {
    if (!(error instanceof FastnError && error.code === "IDENTITY_ORG_NOT_FOUND")) throw error;
    await registerCustomer(customer);
    token = (await mint()).token;
  }
  // Before the customer sets up an integration, so its triggers can install.
  await ensureProductConnection(customer).catch((error) => console.error("[fastn] AgentSDR connection failed", error));
  return token;
}

type AppTrigger = {
  status?: string;
  webhookUrl?: string | null;
  appTrigger?: { events?: { id?: string }[] };
};

const TRIGGER_CACHE_MS = 60_000;
const triggerCache = new Map<string, { at: number; triggers: AppTrigger[] }>();

/**
 * Where to send one organization's event: the ingest URL of every active
 * trigger it has on AgentSDR's connector for that event, one per integration it
 * turned on (Slack, HubSpot, …). AgentSDR needs no change when a customer turns
 * on another app.
 */
export async function customerEventUrls(organizationId: string, eventId: string): Promise<string[]> {
  const connectorId = process.env.FASTN_PRODUCT_CONNECTOR_ID;
  if (!connectorId) return [];
  let cached = triggerCache.get(organizationId);
  if (!cached || Date.now() - cached.at > TRIGGER_CACHE_MS) {
    // As AgentSDR (not the customer): only then does Fastn include webhookUrl.
    const query = new URLSearchParams({ connectorId, end_org_id: organizationId, status: "ACTIVE" });
    const data = (await fastnRequest("GET", `/api/v1/app-triggers?${query}`, { userId: "agentsdr-events" })) as
      | AppTrigger[]
      | { items?: AppTrigger[] };
    cached = { at: Date.now(), triggers: Array.isArray(data) ? data : (data?.items ?? []) };
    triggerCache.set(organizationId, cached);
  }
  return cached.triggers
    .filter((t) => t.status === "ACTIVE" && t.webhookUrl && t.appTrigger?.events?.some((e) => e.id === eventId))
    .map((t) => t.webhookUrl!);
}
