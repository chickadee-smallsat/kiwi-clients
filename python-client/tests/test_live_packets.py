"""Decode real packets produced by the Rust udp-dummy-server (kiwi-measurements encoder)."""
from __future__ import annotations

import socket
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'python-client'))

from decoder import DataBuffer, decode_packet  # noqa: E402

EXE = ROOT / 'target' / 'debug' / ('udp-dummy-server.exe' if sys.platform == 'win32' else 'udp-dummy-server')


@pytest.mark.skipif(not EXE.exists(), reason='build with `cargo build -p udp-dummy-server` first')
def test_decodes_every_packet_from_the_rust_encoder():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('127.0.0.1', 0))
    sock.settimeout(5)
    port = sock.getsockname()[1]
    proc = subprocess.Popen([str(EXE), '-p', str(port), '-a', '127.0.0.1', '--bind', '127.0.0.1'],
                            stdout=subprocess.DEVNULL)
    try:
        bufs = [DataBuffer(256) for _ in range(4)]
        for _ in range(80):
            data, _ = sock.recvfrom(2048)
            assert decode_packet(data, *bufs) is not None
    finally:
        proc.kill()
        proc.wait()
        sock.close()

    accel, gyro, mag, baro = bufs
    assert min(len(accel), len(gyro), len(mag), len(baro)) >= 15
    for _, x, y, z in accel:
        assert 0.7 < (x * x + y * y + z * z) ** 0.5 < 1.1  # dummy gravity is 0.8–1.0 g
    for _, _temp, pres, alt in baro:
        assert 990 < pres < 1040
        assert abs(alt - 44330 * (1 - (pres / 1013.25) ** (1 / 5.255))) < 0.5
