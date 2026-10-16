# imagegen-mcp

A standalone Node.js stdio MCP server with one tool, `generate_image`. It calls an OpenAI-compatible Images service using native `fetch`, saves one PNG, and returns an MCP image block and the actual saved path. It has no Pi dependency or chat-model integration.

## Setup

Requires Node.js 24 or newer and an Images service supporting the request formats below.

```sh
npm ci
npm test
```

Configure these environment variables in your MCP host:

| Variable | Meaning |
| --- | --- |
| `IMAGE_API_BASE_URL` | Required HTTP(S) Images service base URL, for example `http://127.0.0.1:8317/v1`. Its path prefix is preserved. Credentials, query parameters, and fragments are not accepted in this URL. |
| `IMAGE_API_KEY` | Required nonempty credential, sent as `Authorization: Bearer …`. For a local service that ignores authorization, explicitly provide a nonempty placeholder. |
| `IMAGE_MODEL` | Images model identifier; defaults to `gpt-image-2`. This configures the Images service, not the MCP host's chat model. |

Example MCP host configuration; replace the script path and credential for your machine:

```json
{
  "mcpServers": {
    "imagegen": {
      "command": "node",
      "args": ["C:/path/to/imagegen-mcp/server.js"],
      "env": {
        "IMAGE_API_BASE_URL": "http://127.0.0.1:8317/v1",
        "IMAGE_API_KEY": "your-api-key"
      }
    }
  }
}
```

Use an absolute script path. On Windows, forward slashes in the JSON path avoid backslash escaping. Start the server with `node server.js` or `npm start`; the MCP host must communicate over stdin/stdout. Server diagnostics go to stderr. Configure the host's tool timeout to allow long image requests; the server timeout is ten minutes.

## `generate_image`

```json
{
  "prompt": "A small red sailboat on a quiet lake",
  "transparent_background": false,
  "reference_images": [
    { "path": "C:/images/reference.png" },
    { "data_url": "data:image/png;base64,..." }
  ],
  "output_path": "C:/images/sailboat.png"
}
```

The data URI above illustrates the shape; provide complete image base64 in a real call. POSIX absolute paths work on POSIX hosts.

- `prompt`: required nonblank string, at most 32,000 characters.
- `transparent_background`: optional boolean, default `false`.
- `reference_images`: optional ordered array, at most five entries. Each entry contains exactly one absolute local `path` or inline `data_url`. PNG, JPEG, and WebP references are accepted, up to 20 MiB each. Data URIs require matching MIME types and standard padded base64. Remote image URLs are not accepted.
- `output_path`: optional absolute filename ending in `.png` (case-insensitive). Its parent directory must already exist and be writable. When omitted, the server creates an `imagegen-mcp-*` directory in the operating system's temporary directory and saves `image.png` there.

The service receives `model`, `prompt`, `background` (`transparent` or `opaque`), `quality: "auto"`, `size: "auto"`, and `output_format: "png"`. Without references, the server posts JSON to `<base>/images/generations`. With references, it posts JSON to `<base>/images/edits`, adding `images: [{ "image_url": "data:…" }]` in the supplied order. The service must support this JSON edit format.

The server consumes only `data[0].b64_json`. It requires nonempty standard base64 decoding to a structurally valid PNG, including chunk checksums, with a maximum decoded size of 32 MiB. It does not download URL-only results, retry requests, or report usage or cost that the service has not supplied.

### Results and files

Successful results contain:

- A standard MCP `image` block (`mimeType: "image/png"`).
- A text block naming the actual saved file and any save warning.
- `structuredContent` with `saved_path`, `mime: "image/png"`, `model` (the configured model), and optional `save_warning`. Base64 appears only in the image block.

The destination is preflighted before the API call, rejecting existing output paths and detectable parent-directory failures. Actual saves use exclusive creation, so a file created concurrently is never overwritten. If the requested save fails after generation, the server saves to a temporary PNG and returns that path with `save_warning`. If temporary saving also fails, it returns a tool error. Failed writes attempt to remove their own partial file. Temporary files are retained for the caller to use and clean up.

This server is for trusted local MCP clients: supplied absolute paths are read or written directly. Reference checks validate file signatures and basic structure, not full image decoding. There is no directory sandbox. The endpoint, credential, and model are configured by the process environment, not tool arguments.

### Errors and cancellation

Tool failures return MCP `isError: true` with actionable text. Upstream bodies, credentials, base64, and endpoint details are excluded from service diagnostics. Invalid input is rejected before making an image request.

MCP cancellation and the ten-minute local deadline abort the HTTP request. Closing stdin closes the server and aborts outstanding requests. **Local cancellation or timeout cannot guarantee that upstream processing or billing stops.** Requests are never retried automatically because a retry could incur a second charge. Check the service before deciding whether to repeat a failed or interrupted request.

## Tests

`npm test` uses Node's built-in test runner, a loopback mock Images service, and the official MCP stdio client. It covers request routing and payloads, ordered references, validation before generation, PNG results, exclusive saves and temporary fallback, redacted failures, response size limits, cancellation, and startup configuration. Tests do not require image-service credentials or a running Images service.
