import { describe, expect, it } from "vitest";
import { accountsWith, decodeLinkedAccounts, encodeLinkedAccounts, LINKED_ACCOUNTS_TTL_MS } from "./linked-accounts";

const REQUEST = { client_id: "cms_client_1", code_challenge: "challenge-abc" };

describe("the accounts added on the consent page", () => {
  it("round-trips for the same authorization request", () => {
    const value = encodeLinkedAccounts(["u1", "u2"], REQUEST);
    expect(decodeLinkedAccounts(value, REQUEST)).toEqual(["u1", "u2"]);
  });

  it("is refused for another app's or another sign-in's request", () => {
    const value = encodeLinkedAccounts(["u1"], REQUEST);
    expect(decodeLinkedAccounts(value, { ...REQUEST, client_id: "other" })).toEqual([]);
    expect(decodeLinkedAccounts(value, { ...REQUEST, code_challenge: "other" })).toEqual([]);
  });

  it("can't be edited or forged", () => {
    const value = encodeLinkedAccounts(["u1"], REQUEST);
    const [body, mac] = value.split(".");
    const edited = Buffer.from(Buffer.from(body, "base64url").toString().replace("u1", "attacker")).toString("base64url");
    expect(decodeLinkedAccounts(`${edited}.${mac}`, REQUEST)).toEqual([]);
    expect(decodeLinkedAccounts("garbage", REQUEST)).toEqual([]);
    expect(decodeLinkedAccounts(undefined, REQUEST)).toEqual([]);
  });

  it("expires", () => {
    const value = encodeLinkedAccounts(["u1"], REQUEST, 0);
    expect(decodeLinkedAccounts(value, REQUEST, LINKED_ACCOUNTS_TTL_MS + 1)).toEqual([]);
  });

  it("adds the signed-in account once, after the earlier ones", () => {
    expect(accountsWith(["u1"], "u2")).toEqual(["u1", "u2"]);
    expect(accountsWith(["u1", "u2"], "u1")).toEqual(["u1", "u2"]);
  });
});
