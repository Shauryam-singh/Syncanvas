import { createServer } from 'node:http';
import { config } from './config.js';
import { createGateway } from './gateway.js';

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

createGateway(server, { path: config.wsPath });

server.listen(config.port, () => {
  console.log(
    `syncanvas gateway listening on http://localhost:${config.port} (ws: ${config.wsPath})`,
  );
});

process.on('SIGINT', () => {
  console.log('\nshutting down');
  server.close(() => process.exit(0));
});
