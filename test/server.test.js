import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const FAKE_KEY = 'mock-key-not-a-real-credential';

function png(red, green, blue) {
  function chunk(type, data) {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const RED = png(255, 0, 0);
const BLUE = png(0, 0, 255);
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const success = (response, bytes = RED) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
};

async function fixture(t, { trailingSlash = false, model } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'imagegen-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const api = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const record = { url: request.url, method: request.method, headers: request.headers, body: JSON.parse(body) };
    requests.push(record);
    try {
      await handle(request, response, record);
    } catch (error) {
      response.destroy(error);
    }
  });
  let handle = (_request, response) => success(response);
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.closeAllConnections();
    return new Promise((resolve) => api.close(resolve));
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...getDefaultEnvironment(),
      IMAGE_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1${trailingSlash ? '/' : ''}`,
      IMAGE_API_KEY: FAKE_KEY,
      ...(model ? { IMAGE_MODEL: model } : {}),
    },
    stderr: 'pipe',
    maxBufferSize: 50 * 1024 * 1024,
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new Client({ name: 'mock-test-client', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  t.after(() => assert.equal(stderr, '', 'server must not log request data or protocol noise'));
  return {
    directory, client, requests,
    respond: (callback) => { handle = callback; },
    call: (args, options) => client.callTool({ name: 'generate_image', arguments: args }, undefined, options),
  };
}

function assertToolError(result, pattern) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, pattern);
}

async function removeTemporaryResult(result) {
  await rm(path.dirname(result.structuredContent.saved_path), { recursive: true, force: true });
}

test('stdio MCP advertises one tool and generates the configured PNG without dropping /v1', async (t) => {
  const f = await fixture(t, { trailingSlash: true });
  const listing = await f.client.listTools();
  assert.equal(listing.tools.length, 1);
  assert.equal(listing.tools[0].name, 'generate_image');
  assert.deepEqual(Object.keys(listing.tools[0].inputSchema.properties).sort(), [
    'output_path', 'prompt', 'reference_images', 'transparent_background',
  ]);
  const output = path.join(f.directory, 'result.PNG');
  const result = await f.call({ prompt: 'a red square', output_path: output });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { saved_path: output, mime: 'image/png', model: 'gpt-image-2' });
  assert.deepEqual(result.content[0], { type: 'image', data: RED.toString('base64'), mimeType: 'image/png' });
  assert.equal(result.content[1].text, `Saved PNG: ${output}`);
  assert.deepEqual(await readFile(output), RED);
  assert.equal(JSON.stringify(result.structuredContent).includes(RED.toString('base64')), false);
  assert.equal(result.content[1].text.includes(RED.toString('base64')), false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/v1/images/generations');
  assert.equal(f.requests[0].method, 'POST');
  assert.equal(f.requests[0].headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(f.requests[0].body, {
    model: 'gpt-image-2', prompt: 'a red square', background: 'opaque',
    quality: 'auto', size: 'auto', output_format: 'png',
  });
});

test('ordered local and inline references select JSON edits with transparent background and configured model', async (t) => {
  const f = await fixture(t, { model: 'configured-images-model' });
  const local = path.join(f.directory, 'reference.bin');
  await writeFile(local, BLUE);
  const result = await f.call({
    prompt: 'combine both', transparent_background: true,
    reference_images: [{ path: local }, { data_url: dataUrl(RED) }],
  });
  t.after(() => removeTemporaryResult(result));
  assert.equal(result.isError, undefined);
  assert.equal(f.requests[0].url, '/v1/images/edits');
  assert.deepEqual(f.requests[0].body, {
    model: 'configured-images-model', prompt: 'combine both', background: 'transparent',
    quality: 'auto', size: 'auto', output_format: 'png',
    images: [{ image_url: dataUrl(BLUE) }, { image_url: dataUrl(RED) }],
  });
  assert.equal(result.structuredContent.model, 'configured-images-model');
  assert.equal(path.isAbsolute(result.structuredContent.saved_path), true);
  assert.deepEqual(await readFile(result.structuredContent.saved_path), RED);
});

test('invalid inputs and obvious output conflicts fail before any paid API request', async (t) => {
  const f = await fixture(t);
  const existing = path.join(f.directory, 'existing.png');
  await writeFile(existing, 'keep me');
  const empty = path.join(f.directory, 'empty.png');
  await writeFile(empty, '');
  const oversized = path.join(f.directory, 'oversized.png');
  await writeFile(oversized, '');
  await truncate(oversized, 20 * 1024 * 1024 + 1);
  const cases = [
    [{ prompt: '' }, /prompt|small/i],
    [{ prompt: '   ' }, /blank/i],
    [{ prompt: 123 }, /string/i],
    [{ prompt: 'x', transparent_background: 'yes' }, /boolean/i],
    [{ prompt: 'x', reference_images: Array.from({ length: 6 }, () => ({ data_url: dataUrl(RED) })) }, /5|big/i],
    [{ prompt: 'x', reference_images: [{ path: existing, data_url: dataUrl(RED) }] }, /Invalid|union|Unrecognized/i],
    [{ prompt: 'x', reference_images: [{ path: 'relative.png' }] }, /absolute/i],
    [{ prompt: 'x', reference_images: [{ data_url: 'https://example.invalid/image.png' }] }, /inline|remote/i],
    [{ prompt: 'x', reference_images: [{ data_url: 'data:image/png;base64,@@@@' }] }, /base64/i],
    [{ prompt: 'x', reference_images: [{ data_url: 'data:image/png;base64,' }] }, /nonempty/i],
    [{ prompt: 'x', reference_images: [{ data_url: `data:image/jpeg;base64,${RED.toString('base64')}` }] }, /MIME/i],
    [{ prompt: 'x', reference_images: [{ path: path.join(f.directory, 'missing.png') }] }, /read reference/i],
    [{ prompt: 'x', reference_images: [{ path: f.directory }] }, /regular image/i],
    [{ prompt: 'x', reference_images: [{ path: empty }] }, /nonempty/i],
    [{ prompt: 'x', reference_images: [{ path: oversized }] }, /20 MiB/i],
    [{ prompt: 'x', output_path: 'relative.png' }, /absolute/i],
    [{ prompt: 'x', output_path: path.join(f.directory, 'result.jpg') }, /\.png/i],
    [{ prompt: 'x', output_path: path.join(f.directory, 'missing', 'result.png') }, /parent directory/i],
    [{ prompt: 'x', output_path: existing }, /already exists/i],
  ];
  for (const [args, pattern] of cases) {
    assertToolError(await f.call(args), pattern);
    assert.equal(f.requests.length, 0, JSON.stringify(args).slice(0, 100));
  }
  assert.equal(await readFile(existing, 'utf8'), 'keep me');
});

test('an unwritable output parent fails before a paid request', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.directory, 'unwritable');
  await mkdir(parent);
  await chmod(parent, 0o555);
  let result;
  try {
    result = await f.call({ prompt: 'x', output_path: path.join(parent, 'image.png') });
    assertToolError(result, /writable/i);
    assert.equal(f.requests.length, 0, 'an obvious output failure must not incur an API request');
  } finally {
    await chmod(parent, 0o755);
    if (result?.structuredContent) await removeTemporaryResult(result);
  }
});

test('a concurrent output creator is never overwritten; generated bytes survive in a temporary file', async (t) => {
  const f = await fixture(t);
  const output = path.join(f.directory, 'race.png');
  f.respond(async (_request, response) => {
    await writeFile(output, 'concurrent writer', { flag: 'wx' });
    success(response);
  });
  const result = await f.call({ prompt: 'x', output_path: output });
  t.after(() => removeTemporaryResult(result));
  assert.equal(result.isError, undefined);
  assert.notEqual(result.structuredContent.saved_path, output);
  assert.match(result.structuredContent.save_warning, /temporary PNG/i);
  assert.match(result.content[1].text, /Warning:/);
  assert.equal(await readFile(output, 'utf8'), 'concurrent writer');
  assert.deepEqual(await readFile(result.structuredContent.saved_path), RED);
});

test('a requested directory disappearing after generation falls back without losing the image', async (t) => {
  const f = await fixture(t);
  const parent = await mkdtemp(path.join(f.directory, 'output-'));
  f.respond(async (_request, response) => {
    await rm(parent, { recursive: true });
    success(response);
  });
  const result = await f.call({ prompt: 'x', output_path: path.join(parent, 'image.png') });
  t.after(() => removeTemporaryResult(result));
  assert.equal(result.isError, undefined);
  assert.match(result.structuredContent.save_warning, /temporary PNG/i);
  assert.deepEqual(await readFile(result.structuredContent.saved_path), RED);
});

test('bad upstream responses produce bounded redacted tool errors, never downloads or retries', async (t) => {
  const f = await fixture(t);
  const marker = `secret-body-${FAKE_KEY}-${RED.toString('base64')}`;
  const corrupt = Buffer.from(RED);
  corrupt[corrupt.length - 1] ^= 1;
  const responses = [
    [(response) => { response.writeHead(401); response.end(marker); }, /HTTP 401.*IMAGE_API_KEY/i],
    [(response) => { response.writeHead(429); response.end(marker); }, /HTTP 429.*rate-limited/i],
    [(response) => response.end(marker), /unreadable JSON/i],
    [(response) => response.end(JSON.stringify({ data: [] })), /data\[0\].b64_json/i],
    [(response) => response.end(JSON.stringify({ data: [{ url: 'https://example.invalid/never-download.png' }] })), /base64/i],
    [(response) => response.end(JSON.stringify({ data: [{ b64_json: '' }] })), /nonempty/i],
    [(response) => response.end(JSON.stringify({ data: [{ b64_json: '@@@@' }] })), /base64/i],
    [(response) => success(response, Buffer.from('not a PNG')), /valid PNG/i],
    [(response) => success(response, corrupt), /valid PNG/i],
    [(response) => {
      response.writeHead(302, { Location: 'https://example.invalid/never-redirect' });
      response.end(marker);
    }, /reach.*service/i],
  ];
  for (const [respond, pattern] of responses) {
    f.respond((_request, response) => respond(response));
    const before = f.requests.length;
    const result = await f.call({ prompt: 'x' });
    assertToolError(result, pattern);
    assert.equal(f.requests.length, before + 1, 'no implicit retry');
    const diagnostic = result.content[0].text;
    assert.ok(diagnostic.length < 500);
    assert.equal(diagnostic.includes(FAKE_KEY), false);
    assert.equal(diagnostic.includes(RED.toString('base64')), false);
    assert.equal(diagnostic.includes('127.0.0.1'), false);
  }
});

test('oversized upstream response is stopped rather than buffered without a limit', async (t) => {
  const f = await fixture(t);
  f.respond(async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(Buffer.alloc(46 * 1024 * 1024, 65));
  });
  assertToolError(await f.call({ prompt: 'x' }), /response exceeds/i);
  assert.equal(f.requests.length, 1);
});

test('MCP cancellation aborts the pending HTTP response without retry', async (t) => {
  const f = await fixture(t);
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let notifyAborted;
  const aborted = new Promise((resolve) => { notifyAborted = resolve; });
  f.respond((_request, response) => {
    response.on('close', notifyAborted);
    notifyStarted();
  });
  const controller = new AbortController();
  const pending = f.call({ prompt: 'x' }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending);
  await Promise.race([
    aborted,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP request was not aborted')), 3000);
      timer.unref();
    }),
  ]);
  assert.equal(f.requests.length, 1);
});

test('stdin EOF aborts an outstanding image request and exits without waiting for the deadline', async (t) => {
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let notifyAborted;
  const aborted = new Promise((resolve) => { notifyAborted = resolve; });
  const api = createServer((request, response) => {
    response.once('close', notifyAborted);
    request.resume();
    request.once('end', notifyStarted);
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.closeAllConnections();
    return new Promise((resolve) => api.close(resolve));
  });
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...getDefaultEnvironment(),
      IMAGE_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`,
      IMAGE_API_KEY: FAKE_KEY,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let notifyInitialized;
  const initialized = new Promise((resolve) => { notifyInitialized = resolve; });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.id === 1 && message.result) notifyInitialized();
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({ id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eof-test', version: '1.0.0' },
  } });
  await initialized;
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'x' } } });
  await started;
  const exited = once(child, 'exit');
  child.stdin.end();
  let deadline;
  try {
    const [code, signal] = await Promise.race([
      exited,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('server did not exit after stdin EOF')), 3000); }),
    ]);
    assert.equal(code, 0);
    assert.equal(signal, null);
    await aborted;
    assert.equal(stderr, '');
  } finally {
    clearTimeout(deadline);
  }
});

test('invalid startup configuration fails cleanly without exposing environment values', async () => {
  for (const config of [
    {},
    { IMAGE_API_BASE_URL: 'http://127.0.0.1:1/v1' },
    { IMAGE_API_BASE_URL: 'http://username:secret@127.0.0.1:1/v1', IMAGE_API_KEY: FAKE_KEY },
    { IMAGE_API_BASE_URL: 'file:///private/endpoint', IMAGE_API_KEY: FAKE_KEY },
  ]) {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...getDefaultEnvironment(), ...config }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /IMAGE_API_/);
    assert.equal(stderr.includes(FAKE_KEY), false);
    assert.equal(stderr.includes('username:secret'), false);
    assert.equal(stderr.includes('/private/endpoint'), false);
  }
});
