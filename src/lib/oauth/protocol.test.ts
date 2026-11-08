import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  parseClientRegistration,
  presentedClientCredentials,
  protectedResourceMetadata,
  redirectUriMatches,
  registrableRedirectUri,
  resourceIsOurs,
  verifyPkce,
  withParams,
} from "./protocol";

const ORIGIN = "https://cms.example.com";

describe("discovery metadata", () => {
  it("points the MCP resource at this origin as its authorization server", () => {
    const prm = protectedResourceMetadata(ORIGIN);
    expect(prm.resource).toBe(`${ORIGIN}/api/mcp`);
    expect(prm.authorization_servers).toEqual([ORIGIN]);
  });

  it("advertises PKCE S256 only, and dynamic registration", () => {
    const md = authorizationServerMetadata(ORIGIN);
    expect(md.issuer).toBe(ORIGIN);
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`);
    expect(md.token_endpoint_auth_methods_supported).toContain("none");
  });
});

describe("verifyPkce", () => {
  const verifier = "a".repeat(43) + "-._~xyz";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  it("accepts the S256 transform of the verifier", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });
  it("refuses a different verifier", () => {
    expect(verifyPkce("b".repeat(50), challenge)).toBe(false);
  });
  it("refuses a 'plain' verifier equal to the challenge", () => {
    // plain is unsupported: the challenge itself must not work as a verifier.
    expect(verifyPkce(challenge, challenge)).toBe(false);
  });
  it("refuses a verifier outside RFC 7636's length/charset", () => {
    const short = "abc";
    expect(verifyPkce(short, createHash("sha256").update(short).digest("base64url"))).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("registers https anywhere and http only on loopback", () => {
    expect(registrableRedirectUri("https://claude.ai/api/mcp/auth_callback")).not.toBeNull();
    expect(registrableRedirectUri("http://localhost:33418/callback")).not.toBeNull();
    expect(registrableRedirectUri("http://127.0.0.1:9000/cb")).not.toBeNull();
    expect(registrableRedirectUri("http://evil.example/cb")).toBeNull();
    expect(registrableRedirectUri("javascript:alert(1)")).toBeNull();
    expect(registrableRedirectUri("https://claude.ai/cb#frag")).toBeNull();
    expect(registrableRedirectUri("https://user:pw@claude.ai/cb")).toBeNull();
  });

  it("matches exactly for https", () => {
    const reg = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", reg)).toBe(true);
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback/", reg)).toBe(false);
    expect(redirectUriMatches("https://claude.ai.evil.example/api/mcp/auth_callback", reg)).toBe(false);
  });

  it("lets a loopback redirect vary only by port (RFC 8252 §7.3)", () => {
    const reg = ["http://localhost:1234/callback"];
    expect(redirectUriMatches("http://localhost:5555/callback", reg)).toBe(true);
    expect(redirectUriMatches("http://localhost:5555/other", reg)).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1:5555/callback", reg)).toBe(false);
  });

  it("keeps existing query params when appending", () => {
    expect(withParams("https://a.example/cb?x=1", { code: "c", state: undefined })).toBe(
      "https://a.example/cb?x=1&code=c"
    );
  });
});

describe("resourceIsOurs", () => {
  it("accepts absent, this origin's MCP URL with or without a slash, and refuses others", () => {
    expect(resourceIsOurs(null, ORIGIN)).toBe(true);
    expect(resourceIsOurs(`${ORIGIN}/api/mcp`, ORIGIN)).toBe(true);
    expect(resourceIsOurs(`${ORIGIN}/api/mcp/`, ORIGIN)).toBe(true);
    expect(resourceIsOurs("https://other.example/api/mcp", ORIGIN)).toBe(false);
    expect(resourceIsOurs("not a url", ORIGIN)).toBe(false);
  });
});

describe("parseClientRegistration", () => {
  it("accepts a typical MCP public-client registration", () => {
    const r = parseClientRegistration({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      },
    });
  });

  it("defaults the auth method to client_secret_basic per RFC 7591", () => {
    const r = parseClientRegistration({ redirect_uris: ["https://a.example/cb"] });
    expect(r.ok && r.value.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(r.ok && r.value.client_name).toBe("MCP client");
  });

  it("refuses missing or unsafe redirect URIs", () => {
    expect(parseClientRegistration({})).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseClientRegistration({ redirect_uris: ["http://evil.example/cb"] })).toMatchObject({
      ok: false,
      error: "invalid_redirect_uri",
    });
  });

  it("refuses unsupported grants and auth methods", () => {
    expect(
      parseClientRegistration({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] })
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(
      parseClientRegistration({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" })
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
  });
});

describe("presentedClientCredentials", () => {
  it("prefers HTTP Basic", () => {
    const header = `Basic ${Buffer.from("cid:sec%3Aret").toString("base64")}`;
    expect(presentedClientCredentials(header, new URLSearchParams("client_id=other"))).toEqual({
      client_id: "cid",
      client_secret: "sec:ret",
      method: "client_secret_basic",
    });
  });
  it("reads a public client from the form", () => {
    expect(presentedClientCredentials(null, new URLSearchParams("client_id=cid"))).toEqual({
      client_id: "cid",
      client_secret: null,
      method: "none",
    });
  });
});
