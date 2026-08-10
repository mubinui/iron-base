import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_PROVIDERS,
  PROVIDER_CREDENTIALS,
  PROVIDER_METHODS,
  supportsMethod,
  type ProviderId,
} from "../llm/types";
import { AuthManager } from "./authManager";

/** Map-backed stand-ins for the two stores the extension host provides. */
class FakeSecrets {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.values.get(key) as T) ?? fallback;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

let secrets: FakeSecrets;
let globalState: FakeMemento;
let auth: AuthManager;

function build(): AuthManager {
  secrets = new FakeSecrets();
  globalState = new FakeMemento();
  return new AuthManager({
    secrets,
    globalState,
    subscriptions: [],
  } as never);
}

beforeEach(() => {
  auth = build();
});

describe("the provider auth matrix", () => {
  it("lists at least one method for every provider", () => {
    for (const id of ALL_PROVIDERS) {
      expect(PROVIDER_METHODS[id]?.length, `${id} has no way to connect`).toBeGreaterThan(0);
    }
  });

  it("never lists the same method twice for one provider", () => {
    for (const id of ALL_PROVIDERS) {
      const methods = PROVIDER_METHODS[id];
      expect(new Set(methods).size, `${id} repeats a method`).toBe(methods.length);
    }
  });

  it("keeps the legacy credential kind reachable for every provider", () => {
    // The connect picker and the sidebar's card filter still switch on this, so
    // a provider missing from it silently loses its way in.
    for (const id of ALL_PROVIDERS) {
      expect(PROVIDER_CREDENTIALS[id], `${id} has no legacy kind`).toBeDefined();
    }
  });

  it("reports a captured session as a key at the legacy layer", () => {
    // chatgpt-web leads with webSession, which is not a legacy kind. It has to
    // surface as apiKey or `apiKeyFor` stops returning its token.
    expect(PROVIDER_METHODS["chatgpt-web"][0]).toBe("webSession");
    expect(PROVIDER_CREDENTIALS["chatgpt-web"]).toBe("apiKey");
  });
});

describe("resolving which credential to use", () => {
  it("finds nothing when the provider has no credential stored", async () => {
    expect(await auth.resolveCredential("xai")).toBeUndefined();
  });

  it("resolves a pasted key", async () => {
    await auth.setApiKey("xai", "xai-key");
    expect(await auth.resolveCredential("xai")).toMatchObject({
      method: "apiKey",
      secret: "xai-key",
    });
  });

  it("resolves a captured session", async () => {
    await auth.setWebSession("xai", { token: "sess-abc", capturedAt: Date.now() });
    expect(await auth.resolveCredential("xai")).toMatchObject({
      method: "webSession",
      secret: "sess-abc",
    });
  });

  it("prefers the durable key when both are stored", async () => {
    // A session dies in hours and often has no native tool calling, so reaching
    // for it while a key is sitting there would silently downgrade the run.
    await auth.setApiKey("kimi", "kimi-key");
    await auth.setWebSession("kimi", { token: "kimi-sess", capturedAt: Date.now() });

    expect(await auth.resolveCredential("kimi")).toMatchObject({ method: "apiKey" });
  });

  it("honours a pinned method over the default order", async () => {
    await auth.setApiKey("kimi", "kimi-key");
    await auth.setWebSession("kimi", { token: "kimi-sess", capturedAt: Date.now() });
    await auth.setAuthMethodOverride("kimi", "webSession");

    expect(await auth.resolveCredential("kimi")).toMatchObject({
      method: "webSession",
      secret: "kimi-sess",
    });
  });

  it("falls through a pin whose credential has since been cleared", async () => {
    // A stale preference must not be able to disconnect an account that still
    // has something working stored against it.
    await auth.setApiKey("kimi", "kimi-key");
    await auth.setAuthMethodOverride("kimi", "webSession");

    expect(await auth.resolveCredential("kimi")).toMatchObject({ method: "apiKey" });
  });

  it("ignores a pin naming a method the provider cannot use", async () => {
    await auth.setApiKey("kimi", "kimi-key");
    await auth.setAuthMethodOverride("kimi", "oauth");

    expect(auth.authMethodOverride("kimi")).toBeUndefined();
    expect(await auth.resolveCredential("kimi")).toMatchObject({ method: "apiKey" });
  });
});

describe("disconnecting", () => {
  it("clears every method, not just the live one", async () => {
    await auth.setApiKey("xai", "xai-key");
    await auth.setWebSession("xai", { token: "xai-sess", capturedAt: Date.now() });

    await auth.signOut("xai");

    expect(await auth.resolveCredential("xai")).toBeUndefined();
  });

  it("drops a pinned method on disconnect", async () => {
    await auth.setWebSession("xai", { token: "xai-sess", capturedAt: Date.now() });
    await auth.setAuthMethodOverride("xai", "webSession");

    await auth.signOut("xai");

    expect(auth.authMethodOverride("xai")).toBeUndefined();
  });

  it("sweeps captured sessions when everything is cleared", async () => {
    // Sessions live under derived keys that appear in no map, so the sweep has
    // to walk the provider list. Missing one leaves a live token behind after
    // the user asked for everything to be forgotten.
    const withSessions: ProviderId[] = ALL_PROVIDERS.filter((id) =>
      supportsMethod(id, "webSession"),
    );
    for (const id of withSessions) {
      await auth.setWebSession(id, { token: `${id}-sess`, capturedAt: Date.now() });
    }

    await auth.signOutAll();

    expect(secrets.values.size).toBe(0);
  });
});
