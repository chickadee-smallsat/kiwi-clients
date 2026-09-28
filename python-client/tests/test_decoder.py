"""Unit tests for the UDP packet decoder and data-rate counter."""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from decoder import (  # noqa: E402
    ACCEL_CODE,
    BARO_CODE,
    SINGLE_MEASUREMENT_SIZE,
    DataBuffer,
    crc16xmodem,
    decode_packet,
)


def packet(code: int, a: float, b: float, c: float, tstamp: int) -> bytes:
    """Encode a measurement exactly like kiwi-measurements does."""
    body = struct.pack('<Hfff', code, a, b, c) + struct.pack('<Q', tstamp)
    return body + struct.pack('<H', crc16xmodem.checksum(body))


@pytest.fixture
def buffers():
    return [DataBuffer(16) for _ in range(4)]


def test_packet_size_matches_protocol():
    assert len(packet(ACCEL_CODE, 0, 0, 1, 0)) == SINGLE_MEASUREMENT_SIZE


def test_decodes_accel(buffers):
    accel = buffers[0]
    assert decode_packet(packet(ACCEL_CODE, 0.5, -0.25, 1.0, 1_600_000_000), *buffers) == 1_600_000_000
    assert accel[0] == pytest.approx((1_600_000_000, 0.5, -0.25, 1.0))


def test_decodes_baro(buffers):
    baro = buffers[3]
    decode_packet(packet(BARO_CODE, 24.5, 1013.25, 0.0, 7), *buffers)
    assert baro[0] == pytest.approx((7, 24.5, 1013.25, 0.0))


def test_rejects_bad_crc(buffers):
    data = bytearray(packet(ACCEL_CODE, 0, 0, 1, 0))
    data[3] ^= 0xFF
    assert decode_packet(bytes(data), *buffers) is None
    assert len(buffers[0]) == 0


def test_rejects_wrong_length(buffers):
    assert decode_packet(b'\x00' * 10, *buffers) is None


def test_buffer_rounds_up_to_power_of_two():
    buf = DataBuffer(1000)
    for i in range(2000):
        buf.append(i)
    assert len(buf) == 1024


def test_angles_of_a_zero_vector_are_zero_not_nan():
    import numpy as np
    from decoder import xyz_to_rtp
    r, theta, phi = xyz_to_rtp(np.array([0.0, 0.0]), np.array([0.0, 1.0]), np.array([0.0, 0.0]))
    assert list(r) == [0.0, 1.0]
    assert not np.isnan(theta).any() and not np.isnan(phi).any()


def test_latest_timestamp_uses_whichever_sensors_have_data():
    import pandas as pd
    from decoder import latest_timestamp
    empty = pd.DataFrame({'tstamp': []})
    baro = pd.DataFrame({'tstamp': [10, 20]})
    gyro = pd.DataFrame({'tstamp': [15, 25]})
    # Regression: plotting read the accelerometer frame only and crashed when it was empty.
    assert latest_timestamp(empty, gyro, empty, baro) == 25
    assert latest_timestamp(empty, empty, empty, empty) is None
