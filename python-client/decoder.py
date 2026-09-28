# %% Imports
from __future__ import annotations
from collections import deque
import struct
from crc import Calculator, Crc16
import logging

import numpy as np
import pandas as pd

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

crc16xmodem = Calculator(Crc16.XMODEM)  # type: ignore

# %% Constants for sensor data types
SINGLE_MEASUREMENT_SIZE = 24  # measurement

ACCEL_CODE = 0xACC1
GYRO_CODE = 0x6E50
MAG_CODE = 0x9A61
BARO_CODE = 0xB480
# %% Storage data structures


class DataBuffer:
    def __init__(self, maxlen=2000):
        # Ensure maxlen is a power of 2
        maxlen = 1 << int(np.ceil(np.log2(maxlen)))
        self._data = deque(maxlen=maxlen)

    def append(self, item):
        self._data.append(item)

    def clear(self):
        self._data.clear()

    def __getitem__(self, index):
        return self._data[index]

    def __len__(self):
        return len(self._data)

    def to_dataframe(self, columns=None):
        if columns is None:
            columns = ['tstamp', 'x', 'y', 'z']
        return pd.DataFrame(list(self._data), columns=columns)


# %% Data packet structure


def decode_packet(measurement: bytes, accel: DataBuffer, gyro: DataBuffer, mag: DataBuffer, baro: DataBuffer):
    if len(measurement) != SINGLE_MEASUREMENT_SIZE:
        logger.warning(
            f"[UDP] Skipping incomplete measurement: expected {SINGLE_MEASUREMENT_SIZE} got {len(measurement)}")
        return None
    mtype = struct.unpack('<H', measurement[0:2])[0]
    data = measurement[2:14]
    tstamp, crc = struct.unpack('<QH', measurement[14:])
    # Validate CRC
    calc_crc = crc16xmodem.checksum(measurement[:-2])
    if calc_crc != crc:
        logger.warning(
            f"[UDP] Skipping measurement with invalid CRC (expected {crc:#04x}, got {calc_crc:#04x})")
        return None
    targets = {ACCEL_CODE: accel, GYRO_CODE: gyro, MAG_CODE: mag, BARO_CODE: baro}
    if mtype not in targets:
        # Other kiwi-measurements types (labelled temperature, humidity, lux)
        # are not shown by this client.
        logger.debug(f"[UDP] Ignoring measurement type {mtype:#04x}")
        return None
    targets[mtype].append((tstamp, *struct.unpack('<fff', data)))
    return tstamp


def xyz_to_rtp(x, y, z):
    """Magnitude, elevation θ (from the horizontal plane) and azimuth φ.

    A zero vector has no direction; its angles are reported as 0 instead of NaN.
    """
    r = np.sqrt(x**2 + y**2 + z**2)
    cos_polar = np.divide(z, r, out=np.zeros_like(r, dtype=float), where=r > 0)
    theta = np.arccos(np.clip(cos_polar, -1.0, 1.0)) - np.pi / 2
    phi = np.arctan2(y, x)
    return r, theta, phi


def latest_timestamp(*frames: pd.DataFrame):
    """Newest device timestamp across the given frames, or None if all are empty."""
    last = [int(df['tstamp'].iloc[-1]) for df in frames if not df.empty]
    return max(last) if last else None
