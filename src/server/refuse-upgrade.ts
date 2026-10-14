import type { Duplex } from "node:stream";

/**
 * Answers a WebSocket upgrade with an HTTP error and closes the socket.
 * `end()` flushes the response before closing; destroying right after a write
 * can drop it, and the client then sees a reset instead of the status. A
 * client that never reads is cut off after a second.
 */
export function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), 1000).unref();
}
