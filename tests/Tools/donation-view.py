import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

binary, run, mode = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(binary, [binary, "work", "--run", run])

output = bytearray()


def resize(width, height):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))


def read(seconds=0.2):
    data = b""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        try:
            part = os.read(fd, 65536)
        except OSError:
            break
        if not part:
            break
        data += part
    output.extend(data)
    return data


def expect(needle):
    data = b""
    deadline = time.monotonic() + 20
    while needle not in data and time.monotonic() < deadline:
        data += read()
    assert needle in data, (needle, data[-4000:])
    return data


try:
    resize(100, 24)
    expect(b"tool-output")
    assert os.waitpid(pid, os.WNOHANG)[0] == 0, "Transcript arrived after the run ended"
    expect(b"s remaining")
    assert b"\x1b[23;1H" in output, "Budget is not in the fixed footer"
    os.write(fd, b"\x1b[5~\x1b[5~\x1b[5~")
    expect(b"Coding transcript ready")
    resize(48, 12)
    expect(b"\x1b[2J")
    resize(100, 24)
    expect(b"\x1b[2J")
    os.write(fd, b"\x1b[F")
    expect(b"tool-output")
    os.kill(pid, signal.SIGSTOP)
    os.waitpid(pid, os.WUNTRACED)
    os.kill(pid, signal.SIGCONT)
    expect(b"tokate / Donation")
    if mode == "cancel":
        os.write(fd, b"\x03")
    else:
        expect(b"live-verification-output")
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        read()
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            assert os.waitstatus_to_exitcode(status) == (1 if mode == "cancel" else 0), output[-4000:]
            break
    else:
        raise AssertionError("Donation did not finish")
    assert output.count(b"\x1b[?1049h") == 1 and output.count(b"\x1b[?1049l") == 1, "Donation screen was not retained and restored once"
    assert b"INJECTED_TITLE" not in output and b"\x1b]" not in output, "Tool output injected terminal controls"
    assert b"Next: tokate" in output, "Next action is missing after screen restoration"
    if mode == "no_color":
        assert not re.search(rb"\x1b\[(?:[1-9][0-9]*;)*[1-9][0-9]*m", output), "NO_COLOR emitted colors"
    print("PASS donation transcript, fixed footer, scroll, resize, resume and restoration: " + mode)
finally:
    try:
        ended, _ = os.waitpid(pid, os.WNOHANG)
        if not ended:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    except (ChildProcessError, ProcessLookupError):
        pass
    os.close(fd)
