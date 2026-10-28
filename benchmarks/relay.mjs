import { createServer, connect } from 'node:net';

/** Delay each chunk from its arrival time; never add a serial delay per preceding chunk. */
function forward(source, destination, delayMs) {
  const queue = [];
  let bytes = 0,
    timer,
    blocked = false,
    ended = false,
    closed = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed || blocked) return;
    while (queue.length && queue[0].at <= performance.now()) {
      const entry = queue.shift();
      bytes -= entry.data.length;
      if (!destination.write(entry.data)) {
        blocked = true;
        break;
      }
    }
    if (queue.length && !blocked)
      timer = setTimeout(flush, Math.max(0, queue[0].at - performance.now()));
    if (!blocked && bytes < 1024 * 1024) source.resume();
    if (ended && !queue.length && !blocked) destination.end();
  };
  source.on('data', (data) => {
    queue.push({ data, at: performance.now() + delayMs });
    bytes += data.length;
    if (bytes >= 1024 * 1024) source.pause();
    if (!timer) flush();
  });
  source.on('end', () => {
    ended = true;
    flush();
  });
  destination.on('drain', () => {
    blocked = false;
    flush();
  });
  return () => {
    closed = true;
    clearTimeout(timer);
    queue.length = 0;
  };
}

export async function relay(host, port, addedRttMs) {
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ host, port, allowHalfOpen: true });
    const pair = [client, upstream];
    const stops = [
      forward(client, upstream, addedRttMs / 2),
      forward(upstream, client, addedRttMs / 2),
    ];
    for (const socket of pair) {
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.on('error', () => {
        for (const stop of stops) stop();
        for (const peer of pair) peer.destroy();
      });
      socket.once('close', () => {
        sockets.delete(socket);
        // A normal FIN may precede delivery of delayed data in the other direction.
        if (!socket.readableEnded || pair.every((peer) => peer.destroyed)) {
          for (const stop of stops) stop();
          for (const peer of pair) peer.destroy();
        }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
