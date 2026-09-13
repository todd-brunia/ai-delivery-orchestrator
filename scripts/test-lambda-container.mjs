import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// A loopback-only Runtime API fixture exercises the actual native RIC and
// compiled handler inside the final image. No AWS credential or host port enters
// the container, and Docker disables all external networking.
const fixture = String.raw`
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const result = Promise.withResolvers();
let delivered = false;
const server = createServer(async (request, response) => {
  if (request.url === '/2018-06-01/runtime/invocation/next' && !delivered) {
    delivered = true;
    response.writeHead(200, { 'Content-Type': 'application/json',
      'Lambda-Runtime-Aws-Request-Id': 'offline-callback-lifecycle',
      'Lambda-Runtime-Deadline-Ms': String(Date.now() + 15000),
      'Lambda-Runtime-Invoked-Function-Arn': 'arn:aws:lambda:us-east-1:123456789012:function:fixture' });
    response.end('{}'); return;
  }
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    response.writeHead(202); response.end();
    if (request.url === '/2018-06-01/runtime/invocation/offline-callback-lifecycle/response') {
      try { assert.deepEqual(JSON.parse(body), { status: 'disabled' }); result.resolve(); }
      catch (error) { result.reject(error); }
    } else { result.reject(new Error('runtime_reported_error')); }
  }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const child = spawn(process.execPath, ['node_modules/aws-lambda-ric/index.mjs'], {
  env: { PATH: process.env.PATH, AWS_LAMBDA_RUNTIME_API: '127.0.0.1:' + server.address().port,
    _HANDLER: 'dist/runtime/v1/callback-lifecycle-handler.handler', LAMBDA_TASK_ROOT: '/app',
    AWS_LAMBDA_FUNCTION_NAME: 'fixture', AWS_LAMBDA_FUNCTION_VERSION: '$LATEST', AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '256',
    AWS_LAMBDA_LOG_GROUP_NAME: 'fixture', AWS_LAMBDA_LOG_STREAM_NAME: 'fixture',
    CALLBACK_LIFECYCLE_ENABLED: 'false', CALLBACK_LAUNCH_CONFIGURATION_JSON: '{}',
    COORDINATION_TABLE_NAME: 'ai-delivery-orchestrator-pilot-coordination',
    CALLBACK_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/ai-delivery-orchestrator-pilot-callbacks.fifo' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let diagnostics = '';
child.stdout.resume(); child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
child.once('error', () => result.reject(new Error('runtime_start_failed')));
child.once('exit', () => result.reject(new Error('runtime_exited_before_response: ' + diagnostics)));
const deadline = setTimeout(() => result.reject(new Error('runtime_fixture_deadline')), 20000);
try { await result.promise; console.log('Offline native Lambda invocation passed.'); }
finally { clearTimeout(deadline); child.kill('SIGKILL'); server.closeAllConnections(); server.close(); }
`;
const result = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only',
  'ai-delivery-orchestrator:local', 'node', '--input-type=module'],
{ input: fixture, encoding: 'utf8', timeout: 30_000, maxBuffer: 100_000 });
assert.equal(result.status, 0, `Offline Lambda container check failed: ${result.stderr}`);
assert.match(result.stdout, /Offline native Lambda invocation passed/);
process.stdout.write(result.stdout);
