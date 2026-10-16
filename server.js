import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, open, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_OUTPUT_BYTES / 3) * 4 + 1024 * 1024;
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 64;
const TIMEOUT_MS = 10 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

class ToolError extends Error {}

function configFromEnvironment() {
  let base;
  try {
    base = new URL(process.env.IMAGE_API_BASE_URL);
  } catch {
    throw new ToolError('Set IMAGE_API_BASE_URL to the Images service base URL, including any /v1 prefix.');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new ToolError('IMAGE_API_BASE_URL must use HTTP(S), without credentials, query parameters, or a fragment.');
  }
  const key = process.env.IMAGE_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) {
    throw new ToolError('Set IMAGE_API_KEY to a nonempty API key without line breaks.');
  }
  const model = process.env.IMAGE_MODEL?.trim() || 'gpt-image-2';
  return { base: base.href.replace(/\/+$/, ''), key, model };
}

const absolutePath = z.string().min(1).max(32768).refine(
  (value) => path.isAbsolute(value) && !value.includes('\0'),
  'Use an absolute filesystem path without null bytes.',
);
const inputSchema = z.strictObject({
  prompt: z.string().min(1).max(32000).refine((value) => value.trim().length > 0, 'Prompt must not be blank.')
    .describe('Self-contained visual description of the desired image. For edits, state what to change and what to preserve in the reference images.'),
  transparent_background: z.boolean().default(false),
  reference_images: z.array(z.union([
    z.strictObject({ path: absolutePath }),
    z.strictObject({ data_url: z.string().min(1).max(MAX_DATA_URL_LENGTH) }),
  ])).max(5).optional()
    .describe('Up to five ordered PNG, JPEG, or WebP references, each with one server-local absolute path or inline base64 data_url. Remote URLs are not supported.'),
  output_path: absolutePath.refine((value) => path.extname(value).toLowerCase() === '.png', 'Output filename must end in .png.').optional()
    .describe('Absolute .png filename on the server with an existing writable parent directory. Never overwrites an existing path. Omit to save in a temporary directory.'),
});

function decodeBase64(value, maxBytes, label) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ToolError(`${label} must contain nonempty, size-limited standard base64.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) {
    throw new ToolError(`${label} contains invalid base64 or exceeds the image size limit.`);
  }
  return bytes;
}

function isPng(bytes) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let hasHeader = false;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) return false;
      hasHeader = true;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'IEND') return length === 0 && hasData && end === bytes.length;
    offset = end;
  }
  return false;
}

function imageMime(bytes) {
  if (isPng(bytes)) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length
      && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  throw new ToolError('Image bytes must be a nonempty PNG, JPEG, or WebP image matching the declared MIME type.');
}

async function readBounded(stream, maxBytes, message) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maxBytes) throw new ToolError(message);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

async function referenceDataUrl(reference, signal) {
  if ('data_url' in reference) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(reference.data_url);
    if (!match) throw new ToolError('Reference data_url must be an inline PNG, JPEG, or WebP base64 data URI; remote URLs are not supported.');
    const bytes = decodeBase64(reference.data_url.slice(match[0].length), MAX_REFERENCE_BYTES, 'Reference image');
    if (imageMime(bytes) !== match[1]) throw new ToolError('Reference data URI MIME type does not match its image bytes.');
    return reference.data_url;
  }
  let bytes;
  try {
    const info = await stat(reference.path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_REFERENCE_BYTES) {
      throw new ToolError('Reference path must name a nonempty regular image file no larger than 20 MiB.');
    }
    bytes = await readBounded(createReadStream(reference.path, { signal }), MAX_REFERENCE_BYTES, 'Reference image exceeds 20 MiB.');
  } catch (error) {
    if (error instanceof ToolError) throw error;
    signal.throwIfAborted();
    throw new ToolError('Could not read reference image; check that the absolute path names a readable file.');
  }
  return `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`;
}

async function preflightOutput(filename) {
  if (!filename) return;
  try {
    await lstat(filename);
    throw new ToolError('Output path already exists. Choose a new PNG filename; existing files are never overwritten.');
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error.code !== 'ENOENT') throw new ToolError('Could not inspect output path; choose a valid absolute PNG filename.');
  }
  try {
    const parent = path.dirname(filename);
    if (!(await stat(parent)).isDirectory()) throw new Error();
    await access(parent, constants.W_OK);
  } catch {
    throw new ToolError('Output parent directory must already exist and be writable.');
  }
}

async function writeExclusive(filename, bytes) {
  const file = await open(filename, 'wx');
  try {
    await file.writeFile(bytes);
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(filename).catch(() => {});
    throw error;
  }
}

async function saveImage(bytes, requestedPath) {
  let warning;
  if (requestedPath) {
    try {
      await writeExclusive(requestedPath, bytes);
      return { saved_path: requestedPath };
    } catch {
      warning = 'Requested output could not be saved (it may now exist or the directory may be unwritable). The generated image was saved to a temporary PNG instead.';
    }
  }
  try {
    const directory = await mkdtemp(path.join(tmpdir(), 'imagegen-mcp-'));
    const filename = path.join(directory, 'image.png');
    await writeExclusive(filename, bytes);
    return { saved_path: filename, ...(warning ? { save_warning: warning } : {}) };
  } catch {
    throw new ToolError('The generated image could not be saved. Check temporary directory availability and disk space before generating again.');
  }
}

async function generateImage(config, args, clientSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([clientSignal, timeout]);
  try {
    signal.throwIfAborted();
    await preflightOutput(args.output_path);
    const images = [];
    for (const reference of args.reference_images ?? []) {
      signal.throwIfAborted();
      images.push({ image_url: await referenceDataUrl(reference, signal) });
    }
    signal.throwIfAborted();
    let response;
    try {
      response = await fetch(`${config.base}/images/${images.length ? 'edits' : 'generations'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal,
        body: JSON.stringify({
          model: config.model,
          prompt: args.prompt,
          background: args.transparent_background ? 'transparent' : 'opaque',
          quality: 'auto',
          size: 'auto',
          output_format: 'png',
          ...(images.length ? { images } : {}),
        }),
      });
    } catch {
      signal.throwIfAborted();
      throw new ToolError('Could not reach the Images service. Check IMAGE_API_BASE_URL and service availability. No automatic retry was attempted.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const advice = response.status === 401 || response.status === 403 ? 'Check IMAGE_API_KEY and service authorization.'
        : response.status === 404 ? 'Check IMAGE_API_BASE_URL, including its API path prefix.'
          : response.status === 429 ? 'The service is rate-limited; wait before trying again.'
            : 'Check Images service logs before deciding whether to try again.';
      throw new ToolError(`Images service returned HTTP ${response.status}. ${advice} No automatic retry was attempted.`);
    }
    let payload;
    try {
      if (!response.body) throw new Error();
      const bytes = await readBounded(response.body, MAX_RESPONSE_BYTES, 'Images service response exceeds the 32 MiB image response limit.');
      payload = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof ToolError) throw error;
      signal.throwIfAborted();
      throw new ToolError('Images service returned an unreadable JSON response. Expected data[0].b64_json containing PNG base64.');
    }
    const bytes = decodeBase64(payload?.data?.[0]?.b64_json, MAX_OUTPUT_BYTES, 'Images service data[0].b64_json');
    if (!isPng(bytes)) throw new ToolError('Images service data[0].b64_json is not a structurally valid PNG image.');
    const saved = await saveImage(bytes, args.output_path);
    return {
      content: [
        { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `Saved PNG: ${saved.saved_path}${saved.save_warning ? `\nWarning: ${saved.save_warning}` : ''}` },
      ],
      structuredContent: { ...saved, mime: 'image/png', model: config.model },
    };
  } catch (error) {
    const message = clientSignal.aborted ? 'Image request cancelled locally. Upstream processing and billing may still continue.'
      : timeout.aborted ? 'Image request timed out after 10 minutes. Upstream processing and billing may still continue.'
        : error instanceof ToolError ? error.message
          : 'Image generation failed unexpectedly. Check the service and local filesystem; no automatic retry was attempted.';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

try {
  const config = configFromEnvironment();
  const server = new McpServer({ name: 'imagegen-mcp', version: '0.1.0' });
  server.registerTool('generate_image', {
    description: 'Generate one PNG from a prompt when no reference images are supplied, or edit using up to five ordered local or inline references. Saves to an absolute .png filename or a temporary file and returns the image and actual saved path. Existing files are never overwritten. Cancellation or timeout cannot guarantee upstream billing cancellation.',
    inputSchema,
    outputSchema: z.object({ saved_path: z.string(), mime: z.literal('image/png'), model: z.string(), save_warning: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => generateImage(config, args, extra.signal));
  process.stdin.once('end', () => {
    server.close().catch(() => { process.exitCode = 1; });
  });
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 5 * MAX_DATA_URL_LENGTH + 64 * 1024,
  }));
} catch (error) {
  console.error(error instanceof ToolError ? error.message : 'Could not start imagegen-mcp. Check configuration and installed dependencies.');
  process.exitCode = 1;
}
