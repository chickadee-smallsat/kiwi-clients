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
TEMP_CODE = 0x7E70
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
    else:
        # if True:
        # process data
        # print(f"[UDP] Received measurement type {mtype:#04x} at {tstamp} with CRC {crc:#04x}")
        if mtype == ACCEL_CODE:
            x, y, z = struct.unpack('<fff', data[:12])
            accel.append((tstamp, x, y, z))
        elif mtype == GYRO_CODE:
            x, y, z = struct.unpack('<fff', data[:12])
            gyro.append((tstamp, x, y, z))
        elif mtype == MAG_CODE:
            x, y, z = struct.unpack('<fff', data[:12])
            mag.append((tstamp, x, y, z))
        # elif mtype == TEMP_CODE:
        #     source, temperature = struct.unpack('<8sf', data[:12])
        #     source = source.decode(
        #         'utf-8', errors='SurrogateEscape').rstrip('\x00')
        #     if source not in temp:
        #         temp[source] = []
        #     temp[source].append((tstamp, temperature))
        elif mtype == BARO_CODE:
            temperature, pres, alt = struct.unpack('<fff', data[:12])
            baro.append((tstamp, temperature, pres, alt))
        else:
            logger.warning(
                f"[UDP] Skipping measurement with unknown type {mtype:#04x}")
            return None
    return tstamp

def xyz_to_rtp(x, y, z):
    r = np.sqrt(x**2 + y**2 + z**2)
    theta = np.arccos(z / r) - np.pi / 2  # polar angle
    phi = np.arctan2(y, x) # azimuthal angle
    return r, theta, phi