#!/usr/bin/env python3
"""A serial device on a TCP port, for tools/board_run.mjs.

    serial_bridge.py DEVICE PORT

Node has no serial ports of its own. This opens DEVICE for each client that
connects to 127.0.0.1:PORT and passes bytes both ways, so that the page's own
code can talk to a real board from a terminal. One client at a time.

Each message is one byte of kind, four bytes of length (big endian), and that
many bytes:

    client to bridge    D bytes to write        S {"dtr": bool, "rts": bool}
    bridge to client    O the device is open    E it could not be opened (why)
                        D bytes read            A a change of signals is done
                        L the device has gone (why)

Needs pyserial. It never touches DTR or RTS unless the client says S.
"""
import json
import socket
import struct
import sys
import threading

import serial


def send(conn, kind, payload=b""):
    conn.sendall(kind + struct.pack(">I", len(payload)) + payload)


def exactly(conn, n):
    data = b""
    while len(data) < n:
        more = conn.recv(n - len(data))
        if not more:
            return None
        data += more
    return data


def serve(conn, device):
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    try:
        # No wait for the output to drain, here or below: a firmware that never
        # reads its USB port would hold that wait for ever. A browser does not wait either.
        ser = serial.Serial(device, 115200, timeout=0.02, write_timeout=3)
    except Exception as e:  # not there, or held by another program
        try:
            send(conn, b"E", str(e).encode())
        finally:
            conn.close()
        return
    send(conn, b"O")
    stop = threading.Event()
    lock = threading.Lock()

    def from_serial():
        try:
            while not stop.is_set():
                data = ser.read(4096)
                if data:
                    with lock:
                        send(conn, b"D", data)
        except Exception as e:  # the board has left USB
            try:
                with lock:
                    send(conn, b"L", str(e).encode())
            except OSError:
                pass
        finally:
            stop.set()
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    reader = threading.Thread(target=from_serial, daemon=True)
    reader.start()
    try:
        while not stop.is_set():
            head = exactly(conn, 5)
            if not head:
                break
            kind, size = head[:1], struct.unpack(">I", head[1:])[0]
            payload = exactly(conn, size) if size else b""
            if payload is None:
                break
            if kind == b"D":
                try:
                    ser.write(payload)
                except serial.SerialTimeoutException:
                    pass  # the board takes nothing in: the bytes are dropped, as a full buffer drops them
            elif kind == b"S":
                signals = json.loads(payload)
                if "dtr" in signals:
                    ser.dtr = bool(signals["dtr"])
                if "rts" in signals:
                    ser.rts = bool(signals["rts"])
                with lock:
                    send(conn, b"A")
    except Exception:
        pass
    finally:
        stop.set()
        reader.join(0.5)
        try:
            ser.close()
        except Exception:
            pass
        try:
            conn.close()
        except OSError:
            pass


def main():
    device, port = sys.argv[1], int(sys.argv[2])
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(1)
    print(json.dumps({"listening": server.getsockname()[1], "device": device}), flush=True)
    while True:
        conn, _ = server.accept()
        serve(conn, device)


if __name__ == "__main__":
    main()
