"""Recording to disk: a Save/Close button that streams frames to a writer thread."""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path
from queue import Queue
from threading import Thread
from typing import Optional, Tuple

from matplotlib.axes import Axes
from matplotlib.widgets import Button
from pandas import DataFrame

# (accel, gyro, mag, baro) frames, as sent by the UDP loop.
Frames = Tuple[DataFrame, DataFrame, DataFrame, DataFrame]


class StoreSystem(ABC):
    """Records while the button reads "Close"; each recording is one file."""

    SUFFIX = ''

    def __init__(self, dir: Path, axis: Axes):
        self.button = Button(axis, 'Save')
        self.button.on_clicked(self.callback)
        self._dir = dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self.queue: Optional[Queue] = None
        self.thread: Optional[Thread] = None

    @abstractmethod
    def make_thread(self, queue: Queue, path: Path) -> Thread:
        """Writer thread that drains `queue` into the file at `path`."""

    def callback(self, evt) -> None:
        if self.queue is None:
            self.button.label.set_text('Close')
            self.queue = Queue()
            path = self._dir / f"data_{datetime.now().strftime('%Y%m%d_%H%M%S')}{self.SUFFIX}"
            self.thread = self.make_thread(self.queue, path)
            self.thread.start()
        else:
            self.button.label.set_text('Save')
            self._stop()

    def update(self, data: Frames) -> None:
        if self.queue is not None:
            self.queue.put(data)

    def close(self) -> None:
        self._stop()

    def _stop(self) -> None:
        # A plain shutdown lets the writer finish the frames already queued,
        # then its get() raises ShutDown; immediate=True would drop them.
        if self.queue is not None:
            self.queue.shutdown()
            self.queue = None
        if self.thread is not None:
            self.thread.join()
            self.thread = None


class NewRows:
    """Pass on only rows not saved before.

    The plot process hands the store its whole display window on every frame,
    so consecutive windows overlap almost completely. This remembers the last
    saved device timestamp per sensor and returns just the newer rows.
    """

    REBOOT_BACKSTEP_US = 1_000_000

    def __init__(self) -> None:
        self.last: dict[str, int] = {}

    def __call__(self, kind: str, df: DataFrame) -> DataFrame:
        if df.empty:
            return df
        last = self.last.get(kind)
        # The board rebooted if its µs clock is now far behind what was saved.
        if last is not None and df['tstamp'].iloc[-1] < last - self.REBOOT_BACKSTEP_US:
            last = None
        fresh = df if last is None else df[df['tstamp'] > last]
        if not fresh.empty:
            self.last[kind] = int(fresh['tstamp'].iloc[-1])
        return fresh
