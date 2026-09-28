"""Receive-rate bookkeeping for the UDP loop."""
from __future__ import annotations

from time import perf_counter_ns
from typing import Optional, Tuple


class DataRate:
    def __init__(self, update_rate: float = 2.0):
        self.bytecount = 0
        self.count = 0
        self.last = None  # Last timestamp for calculating data rate
        self.update_rate = update_rate

    def update(self, nbytes: int) -> Optional[Tuple[float, str, float, str]]:
        """Count one packet of `nbytes`; every `update_rate` s return (bitrate, unit, packetrate, unit)."""
        now = perf_counter_ns()
        self.bytecount += nbytes
        self.count += 1
        if self.last is None:
            self.last = now
            return
        elapsed = (now - self.last) / 1e9
        if elapsed > self.update_rate:
            datarate = self.bytecount * 8 / elapsed
            packrate = self.count / elapsed
            packunit = 'packets/s'
            self.last = now
            self.bytecount = 0
            self.count = 0
            dataunit = 'bps'
            if datarate > 1024*1024:
                datarate /= 1024*1024
                dataunit = 'Mbps'
            elif datarate > 1024:
                datarate /= 1024
                dataunit = 'Kbps'
            if packrate > 1000:
                packrate /= 1000
                packunit = 'Kpackets/s'
            return (datarate, dataunit, packrate, packunit)

        return None
