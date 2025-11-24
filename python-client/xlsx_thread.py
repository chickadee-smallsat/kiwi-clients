from __future__ import annotations

from datetime import datetime
from pathlib import Path
from queue import Queue, ShutDown
from threading import Thread
from typing import Iterable, List, Optional, Tuple
from matplotlib.axes import Axes
from matplotlib.widgets import Button
from pandas import DataFrame, ExcelWriter

from storesystem import StoreSystem


class XlsxDataset(StoreSystem):
    def __init__(self, dir: Path, axis: Axes):
        self.button = Button(axis, 'Save')
        self.button.on_clicked(self.callback)
        self._dir = dir
        if not self._dir.exists():
            self._dir.mkdir(parents=True, exist_ok=True)
        self.queue: Optional[Queue] = None
        self.ncthread: Optional[XlsxThread] = None

    def get_artist(self):
        return self.button

    def callback(self, evt):
        # print(f"Button clicked, {self.queue is None}, {self.ncthread is None}")
        if self.queue is None:
            self.button.label.set_text('Close')
            self.queue = Queue()
            self.ncthread = XlsxThread(
                self.queue, self._dir / f"data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx")
            self.ncthread.start()
        else:
            self.button.label.set_text('Save')
            self.queue.shutdown(immediate=True)
            self.queue = None
            if self.ncthread is not None:
                self.ncthread.join()
                self.ncthread = None

    def update(self, data: List[Tuple[int, DataFrame]]):
        if self.queue is not None:
            self.queue.put(data)
        else:
            pass

    def close(self):
        if self.queue is not None:
            self.queue.shutdown(immediate=True)
            self.queue = None
        if self.ncthread is not None:
            self.ncthread.join()
            self.ncthread = None
            print("XLSX file closed")
        else:
            print("No XLSX file to close")


class XlsxThread(Thread):
    def __init__(self, queue: Queue, name: Path):
        super().__init__()
        self.queue = queue
        self.fname = name
        self.writer: Optional[ExcelWriter] = None

    def run(self):
        # Implement the thread's activity here
        kinds = ['accel', 'gyro', 'mag', 'baro']
        if self.writer is None:
            self.writer = ExcelWriter(self.fname, engine='openpyxl')
        print(f"Excel file {self.fname} opened")
        while True:
            try:
                data = self.queue.get()
            except ShutDown:
                break
            for (kind, df) in zip(kinds, data):
                df: DataFrame = df
                update_dataset(self.writer, df, kind)
        self.writer.close()
        print(f"Excel file {self.fname} closed")


def update_dataset(writer: ExcelWriter, df: DataFrame, id: str):
    """Update the netCDF4 Dataset with new data from the DataFrame."""
    df.to_excel(writer, sheet_name=id, index=False)
