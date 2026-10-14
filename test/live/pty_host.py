#!/usr/bin/env python3
"""Host one agent CLI under a pseudo-terminal for the live bus gate.

usage: pty_host.py --cwd DIR [--cols N] [--rows N] -- argv...

The child inherits this process's environment. stdin takes newline-delimited
JSON commands:
  {"type": "text", "data": "..."}  write data to the PTY raw (no newline added)
  {"type": "tail"}                 print {"type":"tail","data": last 3000 chars}
  {"type": "kill"}                 terminate the agent and exit
stdout carries one JSON object per line: {"type":"started","pid":N} first,
then tail replies, then {"type":"exit","code":N}. EOF on stdin or SIGTERM
kills the agent (its whole process group) — a gate must never leak agents.

Stdlib only. The agent's screen is not emulated: the rolling buffer is the raw
output with ANSI escapes stripped, which is enough to see where a TUI stopped.
"""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

BUFFER_MAX = 200_000
TAIL_CHARS = 3000
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]")
# Terminal queries a TUI may block on at startup, and the answer a real
# terminal would give. Without a reply some TUIs stall before their first frame.
QUERIES = (
    (b"\x1b[6n", b"\x1b[1;1R"),   # cursor position report
    (b"\x1b[c", b"\x1b[?1;2c"),   # primary device attributes
    (b"\x1b[0c", b"\x1b[?1;2c"),
)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def parse_args(argv):
    opts = {"cwd": os.getcwd(), "cols": 160, "rows": 48}
    i = 0
    while i < len(argv) and argv[i] != "--":
        key = argv[i].lstrip("-")
        if key not in opts or i + 1 >= len(argv):
            sys.exit("usage: pty_host.py --cwd DIR [--cols N] [--rows N] -- argv...")
        opts[key] = argv[i + 1] if key == "cwd" else int(argv[i + 1])
        i += 2
    child = argv[i + 1:]
    if not child:
        sys.exit("pty_host.py: no agent argv after --")
    return opts, child


def main():
    opts, child = parse_args(sys.argv[1:])
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(opts["cwd"])
            env = dict(os.environ)
            env.setdefault("TERM", "xterm-256color")
            os.execvpe(child[0], child, env)
        except Exception as err:  # noqa: BLE001 — report and die in the child
            os.write(2, ("pty_host exec failed: %s\n" % err).encode())
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", opts["rows"], opts["cols"], 0, 0))
    emit({"type": "started", "pid": pid})

    buf = bytearray()
    pending = b""
    state = {"done": False}

    def kill_child(*_):
        if state["done"]:
            return
        state["done"] = True
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except OSError:
                try:
                    os.kill(pid, sig)
                except OSError:
                    return
            deadline = time.time() + 2
            while time.time() < deadline:
                try:
                    if os.waitpid(pid, os.WNOHANG)[0] == pid:
                        return
                except ChildProcessError:
                    return
                time.sleep(0.05)

    signal.signal(signal.SIGTERM, lambda *_: (kill_child(), sys.exit(143)))
    signal.signal(signal.SIGHUP, lambda *_: (kill_child(), sys.exit(129)))

    stdin_fd = sys.stdin.fileno()
    stdin_open = True
    exit_code = None
    while True:
        fds = [fd] + ([stdin_fd] if stdin_open else [])
        try:
            ready, _, _ = select.select(fds, [], [], 0.5)
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            for query, answer in QUERIES:
                if query in data:
                    os.write(fd, answer)
            buf.extend(data)
            if len(buf) > BUFFER_MAX:
                del buf[: len(buf) - BUFFER_MAX]
        if stdin_open and stdin_fd in ready:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                stdin_open = False
                kill_child()
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    cmd = json.loads(line)
                except ValueError:
                    emit({"type": "error", "error": "stdin line is not JSON"})
                    continue
                kind = cmd.get("type")
                if kind == "text":
                    os.write(fd, str(cmd.get("data", "")).encode())
                elif kind == "tail":
                    text = ANSI.sub(b"", bytes(buf)).decode("utf-8", "replace")
                    emit({"type": "tail", "data": text[-TAIL_CHARS:]})
                elif kind == "kill":
                    kill_child()
                    emit({"type": "exit", "code": None})
                    return
                else:
                    emit({"type": "error", "error": "unknown command %r" % kind})
        if state["done"]:
            break

    try:
        _, status = os.waitpid(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        pass
    kill_child()
    emit({"type": "exit", "code": exit_code})


if __name__ == "__main__":
    main()
