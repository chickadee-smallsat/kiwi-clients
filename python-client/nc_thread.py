"""NetCDF recording (--savekind netcdf): one group per sensor, appended as data arrives."""
from __future__ import annotations

from pathlib import Path
from queue import Queue, ShutDown
from threading import Thread

from netCDF4 import Dataset
from pandas import DataFrame

from storesystem import NewRows, StoreSystem


class NcDataset(StoreSystem):
    SUFFIX = '.nc'

    def make_thread(self, queue: Queue, path: Path) -> Thread:
        return NcThread(queue, path)


class NcThread(Thread):
    def __init__(self, queue: Queue, name: Path):
        super().__init__()
        self.queue = queue
        self.fname = name

    def run(self):
        kinds = ['accel', 'gyro', 'mag', 'baro']
        fresh = NewRows()
        dataset = Dataset(self.fname, 'w', format='NETCDF4')
        print(f"NetCDF file {self.fname} opened")
        try:
            while True:
                try:
                    data = self.queue.get()
                except ShutDown:
                    break
                for kind, df in zip(kinds, data, strict=True):
                    new = fresh(kind, df)
                    if not new.empty:
                        append_rows(dataset, new, kind)
        finally:
            dataset.close()  # always flush what was written
            print(f"NetCDF file {self.fname} closed")


def append_rows(ds: Dataset, df: DataFrame, kind: str):
    """Append the frame's rows to the sensor's group, creating it on first use."""
    columns = [col for col in df.columns if col != 'tstamp']
    if kind not in ds.groups:
        group = ds.createGroup(kind)
        group.createDimension('tstamp', None)
        group.createVariable('tstamp', 'f8', ('tstamp',), compression='zlib')
        for col in columns:
            group.createVariable(col, 'f4', ('tstamp',), compression='zlib')
    group = ds.groups[kind]
    start = len(group.variables['tstamp'])
    group.variables['tstamp'][start:] = df['tstamp'].values
    for col in columns:
        group.variables[col][start:] = df[col].values
