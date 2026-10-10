const http = require('node:http');
const endpoint = process.env.PASEO_AGY_STEERING_URL;
const phase = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!endpoint || !['pre', 'post'].includes(phase)) {
    process.stdout.write('{}');
    return;
  }
  const { conversationId } = JSON.parse(input);
  const url = new URL(`${endpoint}/${phase}`);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid steering endpoint');
  const request = http.request(url, { method: 'POST', timeout: 3000, headers: { 'Content-Type': 'application/json' } }, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      process.stderr.write('Steering hook was rejected by its session bridge.\n');
      process.exitCode = 1;
      return;
    }
    response.pipe(process.stdout);
  });
  request.on('timeout', () => request.destroy(new Error('Steering hook timed out')));
  request.on('error', () => {
    process.stderr.write('Steering hook could not reach its session bridge.\n');
    process.exitCode = 1;
  });
  request.end(JSON.stringify({ conversationId }));
});
