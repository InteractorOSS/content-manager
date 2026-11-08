# Core `/execute` response fixtures

One file per `<service_id>.<capability>[.<variant>]` (a variant is a second answer to the same capability — the second image of two, a body-only id), each the full body Core's
`POST /api/v1/execute` answers with. A success is `{ data, metadata }`: `data`
is the provider's response body and `metadata.response_headers` holds the
provider's response headers (G#44). A refusal is `{ error }` with HTTP 422.
Load them with `coreFixture()` from `index.ts`.

**None of these files is a live recording.** This sandbox has no Core
credentials, so every file was written by hand. The success and 422 envelopes
are transcribed from Core's source.
`response_headers` follows G#44's assumed shape, because Core had not shipped
G#44 at that commit. The capability names `list_admin_organizations` (LinkedIn)
and `list_pages` on the `instagram` service are G#45's, which had not shipped
either; the provider bodies are what LinkedIn and Graph document. The same
goes for the media capabilities below (`upload_media`, `initialize_image_upload`,
`upload_image` — the PUT of the bytes to LinkedIn's `uploadUrl` —,
`upload_page_photo`, `create_media_container`, `publish_media`, `get_media`):
the names are the ones G#45 was asked for, and if Core ships different ones,
only the adapter in `capabilities.ts` and these file names change. The same holds
for the thread and first-comment calls: a reply is `create_post` with
`reply.in_reply_to_tweet_id` (X documents that body), and `create_comment` on
`linkedin` and `facebook-graph-api` is the name this CMS assumes for LinkedIn
`POST /rest/socialActions/{urn}/comments` and Graph `POST /{post-id}/comments`.

| File | Envelope | Provider body |
|------|----------|---------------|
| `facebook-graph-api.list_pages.json` | transcribed: `execute_controller.ex` success (`data` + `metadata.execution_type/executed_at/latency_ms`) | Graph `/me/accounts` (`fields=id,name`) |
| `slack.conversations_list.json` | same | Slack `conversations.list` |
| `linkedin.get_me.json` | same | LinkedIn `/v2/userinfo` |
| `linkedin.list_admin_organizations.json` | same | LinkedIn `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED` with the `organization~(localizedName)` projection; the second element is unprojected, as an answer without the projection comes back |
| `instagram.list_pages.json` | same | Graph `/me/accounts` (`fields=id,name,instagram_business_account{id,username}`): one Page with an Instagram business account, one with none, one whose account has no username, and a second Page linked to the first one's account (offered once) |
| `twitter.create_post.json` | G#44-assumed: adds `response_headers` | X API v2 `POST /2/tweets` |
| `linkedin.create_rest_post.json` | G#44-assumed: adds `response_headers` | LinkedIn `POST /rest/posts`: 201, empty body, new id only in `x-restli-id` |
| `twitter.upload_media.json` | G#44-assumed | X API v2 `POST /2/media/upload`: `{data: {id, media_key, expires_after_secs}}` |
| `twitter.upload_media.v1.json` | same | X API v1.1 `media/upload`: `{media_id_string}` (the shape an older relay answers with) |
| `linkedin.initialize_image_upload[.second].json` | same | LinkedIn `POST /rest/images?action=initializeUpload`: `{value: {uploadUrl, image}}` |
| `linkedin.upload_image.json` | same | the PUT to `uploadUrl`: 201, empty body |
| `linkedin.create_rest_post.body_id.json` | transcribed, no `response_headers` (a Core before G#44) | a `/rest/posts` answer carrying the id in the body, for the fallback |
| `facebook-graph-api.upload_page_photo[.second].json` | G#44-assumed | Graph `POST /{page-id}/photos?published=false`: `{id}` |
| `facebook-graph-api.publish_page_post.json` | same | Graph `POST /{page-id}/feed` with `attached_media`: `{id: "<page>_<post>"}` |
| `instagram.create_media_container[.second\|.carousel].json` | transcribed | Graph `POST /{ig-user-id}/media`: `{id}` (a carousel item, then the CAROUSEL container) |
| `instagram.publish_media.json` | transcribed | Graph `POST /{ig-user-id}/media_publish`: `{id}` |
| `instagram.get_media.json` | transcribed | Graph `GET /{ig-media-id}?fields=permalink` |
| `execute.error_422.json` | transcribed: the 422 from `execute_controller.ex`, error map built by `service_executor/provider_error.ex` (`{error: {code, message, provider: {status, body, retry_after_seconds}}}`) | X `POST /2/tweets` 403, duplicate content |
| `twitter.create_post.reply[.second].json` | G#44-assumed | X API v2 `POST /2/tweets` with `reply.in_reply_to_tweet_id`: tweets 2 and 3 of a thread |
| `linkedin.create_comment.json` | G#44-assumed | LinkedIn `POST /rest/socialActions/{urn}/comments`: 201 with the comment, its URN also in `x-restli-id` |
| `facebook-graph-api.create_comment.json` | G#44-assumed | Graph `POST /{post-id}/comments`: `{id}` |

Provider bodies follow each provider's documented response, and the ids are
illustrative. `response_headers` uses the spelling that `responseHeaders()` in
`src/lib/interactor.ts` reads: a map of header name to a string or list, or a
list of `[name, value]` pairs. If a live capture differs, replace the file with
the capture. The tests should follow Core, not the other way round.
