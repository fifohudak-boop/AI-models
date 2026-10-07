// Runs inside the Postiz container next to Postiz (see docker-compose.yml).
// Postiz serves on port 5000 inside its container, but it also downloads your
// uploaded videos from its own public address (POSTIZ_URL). On your own
// computer that address is http://localhost:4007, so port 4007 has to work
// inside the container too: this forwards it to 5000. (Port 5000 itself
// can't be used on the outside: Macs use it for AirPlay.)
const net = require('node:net');

const PORT = Number(process.env.POSTIZ_LOCAL_PORT) || 4007;

net
  .createServer((client) => {
    const upstream = net.connect(5000, '127.0.0.1');
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  })
  .listen(PORT, '0.0.0.0');
