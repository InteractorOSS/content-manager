import "server-only";
import {
  executeServiceAction,
  executeServiceUpload,
  responseHeaders,
  type ExecuteResult,
} from "@/lib/interactor";
import type { ExecuteFn, ExecuteResponse } from "@/lib/social/capabilities";

/** What a channel row contributes to an /execute call. */
export interface ExecutingChannel {
  service_id: string;
  external_user_id: string;
  /**
   * The Core credential behind the channel. Every place this channel's calls
   * go through passes it as `credential_id`, so a connection that posts to
   * several places — rows sharing one credential — and a reconnect that left
   * an older credential on the same identity both act as the credential the
   * row names, not whichever Core would pick by default.
   */
  credential_id?: string | null;
}

/**
 * The one way social code calls Core for a channel: publishing
 * (`publishTarget`), account discovery and the connect callback all build
 * their execute function here, so the identity and credential a call runs as
 * cannot differ between them.
 */
export function channelExecute(channel: ExecutingChannel): ExecuteFn {
  const target = {
    serviceId: channel.service_id,
    externalUserId: channel.external_user_id,
    credentialId: channel.credential_id ?? null,
  };
  const toResponse = (result: ExecuteResult): ExecuteResponse => ({
    data: result.data ?? {},
    headers: responseHeaders(result),
  });

  const execute: ExecuteFn = async (capabilityName, args) => {
    const result = await executeServiceAction({ ...target, capabilityName, args });
    return result.data ?? {};
  };
  execute.withHeaders = async (capabilityName, args) =>
    toResponse(await executeServiceAction({ ...target, capabilityName, args }));
  execute.upload = async (capabilityName, args, body) =>
    toResponse(await executeServiceUpload({ ...target, capabilityName, args, body }));
  return execute;
}
