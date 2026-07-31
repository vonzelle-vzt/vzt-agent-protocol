/**
 * The single seam between this extension and the herdr daemon.
 *
 * Every byte that crosses to herdr crosses here. When the protocol moves —
 * and it will, herdr is pre-1.0 — this is the one file to change.
 *
 * THE EXTENSION IS A CLIENT. herdr owns the agent processes and always will.
 * VS Code windows reload on every extension update and die with the app; an
 * agent parented to this process would die with it. Nothing in this file may
 * start, own, or parent an agent — no `agent.start`, no `pane.split`, no
 * spawning the herdr binary. The daemon runs the fleet; we only look at it.
 *
 * TWO CONNECTION MODES, because the server demands it (verified against 0.7.5):
 *
 *   request()   The server closes the connection after answering. A second
 *               write on the same socket throws EPIPE and a second read returns
 *               empty. So this opens a connection, sends one request, reads one
 *               line, and destroys it. That is the protocol, not a workaround —
 *               do not "optimise" it into a shared socket.
 *
 *   subscribe() `events.subscribe` is the exception: the server acks with
 *               {"type":"subscription_started"} and then holds the connection
 *               open, streaming newline-delimited {event, data} frames.
 */

import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  HERDR_PROTOCOL,
  type HerdrEventEnvelope,
  type SessionSnapshot,
  type Subscription,
} from "./types.gen";

/** Why the client is not currently delivering events. */
export type ConnectionState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  /** No socket on disk / nothing listening. Normal — herdr just is not running. */
  | { kind: "offline"; detail: string }
  /** Daemon speaks a protocol these generated types were not built for. */
  | { kind: "protocolMismatch"; daemon: number; expected: number };

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** A response frame is either {id, result} or {id, error}. */
interface ResponseFrame {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export function resolveSocketPath(): string {
  // Precedence: explicit env (what the herdr CLI itself honours) > user setting
  // > default. NOTE this is HERDR_SOCKET_PATH, the *server* socket. herdr also
  // has HERDR_CLIENT_SOCKET_PATH / herdr-client.sock, which is a different
  // socket entirely and answers none of these methods.
  const fromEnv = process.env.HERDR_SOCKET_PATH;
  if (fromEnv) {
    return fromEnv;
  }
  const configured = vscode.workspace.getConfiguration("vztMux").get<string>("herdr.socketPath");
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

/** Split a byte stream into complete newline-delimited frames, keeping the remainder. */
class LineBuffer {
  private buf = "";

  /**
   * A frame can and does split across `data` chunks — `layout_updated` payloads
   * run to several KB. Parsing each chunk as JSON drops events on a busy fleet,
   * which looks exactly like "the tree is stale sometimes".
   */
  push(chunk: Buffer): string[] {
    this.buf += chunk.toString("utf8");
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? ""; // trailing partial (or "" if chunk ended clean)
    return lines.filter((l) => l.trim().length > 0);
  }
}

export class HerdrClient implements vscode.Disposable {
  private readonly _onDidChangeState = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private readonly _onDidReceiveEvent = new vscode.EventEmitter<HerdrEventEnvelope>();
  readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

  /** Fires whenever a fresh snapshot is taken: at connect and after every reconnect. */
  private readonly _onDidSeed = new vscode.EventEmitter<SessionSnapshot>();
  readonly onDidSeed = this._onDidSeed.event;

  private state: ConnectionState = { kind: "idle" };
  private stream: net.Socket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private nextId = 1;
  private running = false;
  private subscriptions: Subscription[] = [];

  constructor(private readonly log: vscode.OutputChannel) {}

  getState(): ConnectionState {
    return this.state;
  }

  private setState(next: ConnectionState): void {
    // Suppress duplicate notifications so a flapping daemon does not spam the
    // tree with identical redraws.
    if (JSON.stringify(next) === JSON.stringify(this.state)) {
      return;
    }
    this.state = next;
    this._onDidChangeState.fire(next);
  }

  // --- request/response ----------------------------------------------------

  /**
   * One request, one fresh connection, one line back.
   *
   * Rejects on: no socket (daemon down), a transport error, an `error` frame
   * from the daemon, or the connection closing before a complete line arrived.
   */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socketPath = resolveSocketPath();
    const id = String(this.nextId++);

    return new Promise<T>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      const lines = new LineBuffer();
      let settled = false;

      const finish = (err: Error | undefined, value?: T) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        err ? reject(err) : resolve(value as T);
      };

      sock.setTimeout(10_000, () => finish(new Error(`herdr ${method} timed out after 10s`)));
      sock.on("error", (err) => finish(err));
      sock.on("connect", () => sock.write(`${JSON.stringify({ id, method, params })}\n`));

      sock.on("data", (chunk) => {
        for (const line of lines.push(chunk)) {
          let frame: ResponseFrame;
          try {
            frame = JSON.parse(line) as ResponseFrame;
          } catch {
            finish(new Error(`herdr ${method} returned unparseable JSON: ${line.slice(0, 200)}`));
            return;
          }
          if (frame.error) {
            finish(new Error(`herdr ${method} failed [${frame.error.code}]: ${frame.error.message}`));
            return;
          }
          finish(undefined, frame.result as T);
          return;
        }
      });

      // The daemon closing before a full line means the request never landed.
      sock.on("close", () => finish(new Error(`herdr closed the connection during ${method}`)));
    });
  }

  /** `ping`, used as the protocol guard. */
  async ping(): Promise<{ version: string; protocol: number }> {
    return this.request<{ version: string; protocol: number }>("ping");
  }

  async snapshot(): Promise<SessionSnapshot> {
    const result = await this.request<{ snapshot: SessionSnapshot }>("session.snapshot");
    return result.snapshot;
  }

  /** Focus a pane in the daemon. The ONLY write this extension performs. */
  async focusPane(paneId: string): Promise<void> {
    await this.request("pane.focus", { pane_id: paneId });
  }

  // --- event stream --------------------------------------------------------

  /**
   * Connect, seed from a snapshot, then hold a subscription open. Safe to call
   * repeatedly; a second call while running is a no-op.
   */
  start(subscriptions: Subscription[]): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.subscriptions = subscriptions;
    void this.connect();
  }

  /** Drop the held connection. The daemon and its agents are unaffected. */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stream?.destroy();
    this.stream = undefined;
    this.attempt = 0;
    this.setState({ kind: "idle" });
  }

  private async connect(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.setState({ kind: "connecting" });

    // 1. Protocol guard BEFORE anything else. Running against a daemon whose
    //    wire format these types were not generated from produces a tree that is
    //    subtly, silently wrong — much worse than refusing.
    try {
      const pong = await this.ping();
      if (pong.protocol !== HERDR_PROTOCOL) {
        this.log.appendLine(
          `[herdr] protocol mismatch: daemon speaks ${pong.protocol} (herdr ${pong.version}), ` +
            `these types were generated for ${HERDR_PROTOCOL}. Refusing to guess.`
        );
        this.setState({ kind: "protocolMismatch", daemon: pong.protocol, expected: HERDR_PROTOCOL });
        this.running = false; // a mismatch is not something backoff will fix
        void vscode.window.showErrorMessage(
          `Herdr Fleet disabled: daemon protocol ${pong.protocol}, extension built for ${HERDR_PROTOCOL}. ` +
            `Rebuild the extension (npm run compile) to regenerate types.`
        );
        return;
      }
    } catch (err) {
      this.handleDisconnect(err);
      return;
    }

    // 2. Seed. Events are a delta stream with no replay — anything that happened
    //    while we were away is simply gone, so every (re)connect must re-seed
    //    from a snapshot before resuming events or the tree drifts from reality.
    try {
      this._onDidSeed.fire(await this.snapshot());
    } catch (err) {
      this.handleDisconnect(err);
      return;
    }

    // 3. Hold the subscription open.
    const socketPath = resolveSocketPath();
    const sock = net.createConnection(socketPath);
    this.stream = sock;
    const lines = new LineBuffer();
    let acked = false;

    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({
          id: String(this.nextId++),
          method: "events.subscribe",
          params: { subscriptions: this.subscriptions },
        })}\n`
      );
    });

    sock.on("data", (chunk) => {
      for (const line of lines.push(chunk)) {
        let frame: { event?: string; data?: unknown; result?: { type?: string }; error?: { message: string } };
        try {
          frame = JSON.parse(line);
        } catch {
          this.log.appendLine(`[herdr] dropped unparseable frame: ${line.slice(0, 200)}`);
          continue;
        }
        if (frame.error) {
          this.log.appendLine(`[herdr] subscription error: ${frame.error.message}`);
          continue;
        }
        if (!acked && frame.result?.type === "subscription_started") {
          acked = true;
          this.attempt = 0; // a working stream resets the backoff
          this.setState({ kind: "connected" });
          this.log.appendLine(`[herdr] subscribed (${this.subscriptions.length} event kinds)`);
          continue;
        }
        if (frame.event) {
          this._onDidReceiveEvent.fire(frame as unknown as HerdrEventEnvelope);
        }
      }
    });

    sock.on("error", (err) => this.handleDisconnect(err));
    // A clean `end` is still a disconnect: herdr stopping is the common case.
    sock.on("close", () => this.handleDisconnect(undefined));
  }

  private handleDisconnect(err: unknown): void {
    this.stream?.destroy();
    this.stream = undefined;
    if (!this.running) {
      return;
    }

    const message = err instanceof Error ? err.message : "connection closed";
    const missing =
      (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
      (err as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED" ||
      !fs.existsSync(resolveSocketPath());

    this.setState(
      missing
        ? { kind: "offline", detail: "herdr is not running" }
        : { kind: "offline", detail: message }
    );

    // Exponential backoff, capped. A daemon that is simply not running is a
    // normal state, not an error to shout about — log the first attempt only so
    // an all-day VS Code session does not accumulate thousands of lines.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt++;
    if (this.attempt === 1) {
      this.log.appendLine(`[herdr] disconnected (${message}); retrying every ${delay}ms up to ${RECONNECT_MAX_MS}ms`);
    }
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  dispose(): void {
    this.stop();
    this._onDidChangeState.dispose();
    this._onDidReceiveEvent.dispose();
    this._onDidSeed.dispose();
  }
}
