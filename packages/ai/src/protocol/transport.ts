import type { Socket } from 'bun';

import { Huffman } from '@gemwright/common/huffman';

import type { ConnectionConfig } from '../connection';
import { timed } from '../stall-probe';
import { PacketFramer } from './framing';

// Bun's native TCP socket: writes go straight to the kernel without node:net's stream layer, which
// dominated main-thread time at 100 clients. Bun does not buffer, so unsent bytes queue until drain.
// Idle detection stays in PlayerSession (no packet within timeoutMs fails the session).
export class Transport {
  private socket: Socket<undefined> | null = null;
  private readonly framer = new PacketFramer();
  private readonly decoder: Huffman | null;
  private closing = false;
  private failed = false;
  private connected = false;
  private readonly decoded = Buffer.allocUnsafe(65536);
  private queued: Buffer[] = [];
  private queuedBytes = 0;

  constructor(
    compressed: boolean,
    private readonly onPacket: (packet: Buffer) => void,
    private readonly onFailure: (error: Error) => void
  ) {
    this.decoder = compressed ? new Huffman() : null;
  }

  private fail(error: Error): void {
    if (this.closing || this.failed) return;
    this.failed = true;
    this.onFailure(error);
  }

  private receive(bytes: Buffer): void {
    if (this.closing) return;
    try {
      // Bound decoder output per small input slice, independently of TCP coalescing.
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        const block = bytes.subarray(offset, offset + 4096);
        const decoder = this.decoder;
        const decoded = decoder ? timed('decode', () => decoder.decompress(block, 65536, this.decoded)) : block;
        for (const packet of this.framer.push(decoded)) this.onPacket(packet);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Protocol decoding failed'));
      this.close();
    }
  }

  async open(config: ConnectionConfig): Promise<void> {
    const failure = (error: Error & { code?: string }) =>
      new Error(`Shard TCP connection failed (${error.code ?? 'unknown'})`);
    try {
      this.socket = await Bun.connect({
        hostname: config.host,
        port: config.port,
        socket: {
          open: (socket) => {
            this.connected = true;
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 10000);
          },
          data: (_socket, bytes) => timed('receive', () => this.receive(bytes)),
          drain: () => this.flush(),
          error: (_socket, error) => this.fail(failure(error)),
          close: () => {
            this.connected = false;
            if (this.closing) return;
            try {
              this.framer.finish();
            } catch (error) {
              this.fail(error as Error);
              return;
            }
            this.fail(new Error('Shard connection closed'));
          }
        }
      });
    } catch (error) {
      throw failure(error as Error);
    }
  }

  private flush(): void {
    const socket = this.socket;
    while (socket && this.queued.length) {
      const next = this.queued[0];
      if (!next) break;
      const wrote = socket.write(next);
      if (wrote < 0) return;
      this.queuedBytes -= Math.max(0, wrote);
      if (wrote < next.length) {
        this.queued[0] = next.subarray(Math.max(0, wrote));
        return;
      }
      this.queued.shift();
    }
  }

  write(packet: Buffer): void {
    const socket = this.socket;
    if (!socket || this.closing || this.failed || !this.connected) throw new Error('Shard socket is not writable');
    if (this.queuedBytes + packet.length > 1024 * 1024) throw new Error('Shard send queue exceeded 1 MiB');
    if (!this.queued.length) {
      const wrote = socket.write(packet);
      if (wrote >= packet.length) return;
      this.queued.push(Buffer.from(packet.subarray(Math.max(0, wrote))));
      this.queuedBytes += packet.length - Math.max(0, wrote);
      return;
    }
    // Queued bytes must leave first; copy because callers may reuse their buffers.
    this.queued.push(Buffer.from(packet));
    this.queuedBytes += packet.length;
  }

  close(): void {
    this.closing = true;
    this.socket?.terminate();
  }
}
