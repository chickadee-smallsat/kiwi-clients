from __future__ import annotations

from datetime import datetime
from pathlib import Path
from queue import Queue, ShutDown
from threading import Thread
from typing import Iterable, List, Optional, Tuple

from matplotlib.axes import Axes
from matplotlib.widgets import Button
from netCDF4 import Dataset
import pandas as pd


class NcDataset:
    def __init__(self, dir: Path, axis: Axes):
        self.button = Button(axis, 'Save')
        self.button.on_clicked(self.callback)
        self._dir = dir
        if not self._dir.exists():
            self._dir.mkdir(parents=True, exist_ok=True)
        self.queue: Optional[Queue] = None
        self.ncthread: Optional[NcThread] = None

    def get_artist(self):
        return self.button

    def callback(self, evt):
        # print(f"Button clicked, {self.queue is None}, {self.ncthread is None}")
        if self.queue is None:
            self.button.label.set_text('Close')
            self.queue = Queue()
            self.ncthread = NcThread(
                self.queue, self._dir / f"data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.nc")
            self.ncthread.start()
        else:
            self.button.label.set_text('Save')
            self.queue.shutdown(immediate=True)
            self.queue = None
            if self.ncthread is not None:
                self.ncthread.join()
                self.ncthread = None

    def update(self, data: List[Tuple[int, pd.DataFrame]]):
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
            print("NetCDF file closed")
        else:
            print("No NetCDF file to close")


class NcThread(Thread):
    def __init__(self, queue: Queue, name: Path):
        super().__init__()
        self.queue = queue
        self.fname = name
        self.dataset: Optional[Dataset] = None

    def run(self):
        # Implement the thread's activity here
        kinds = ['accel', 'gyro', 'mag', 'baro']
        if self.dataset is None:
            self.dataset = Dataset(self.fname, 'w', format='NETCDF4')
        print(f"NetCDF file {self.fname} opened")
        while True:
            try:
                data = self.queue.get()
            except ShutDown:
                break
            for (kind, df) in zip(kinds, data):
                df: pd.DataFrame = df
                update_dataset(self.dataset, df, kind)
        self.dataset.close()
        print(f"NetCDF file {self.fname} closed")


def update_dataset(ds: Dataset, df: pd.DataFrame, id: str):
    """Update the netCDF4 Dataset with new data from the DataFrame."""
    columns = [col for col in df.columns if col != 'tstamp']
    if id not in ds.groups.keys():
        print(f'\tCreating NetCDF group for ID {id}')
        group = ds.createGroup(id)
        group.createDimension('tstamp', None)
        nctime = group.createVariable(
            'tstamp', 'f8', ('tstamp',), compression='zlib')
        for col in columns:
            group.createVariable(
                col, 'f4', ('tstamp',), compression='zlib')
        nctime[:] = df['tstamp'].values  # type: ignore
        for col in columns:
            var = group.variables[col]
            var[:] = df[col].values  # type: ignore
    else:
        group = ds.groups[id]
        nctime = group.variables['tstamp']
        dlen = len(nctime)
        nctime[dlen:] = df['tstamp'].values  # type: ignore
        for col in columns:
            var = group.variables[col]
            var[dlen:] = df[col].values  # type: ignore
