"""Excel recording (--savekind excel): one sheet per sensor, appended as data arrives."""
from __future__ import annotations

from pathlib import Path
from queue import Queue, ShutDown
from threading import Thread

from pandas import ExcelWriter

from storesystem import NewRows, StoreSystem


class XlsxDataset(StoreSystem):
    SUFFIX = '.xlsx'

    def make_thread(self, queue: Queue, path: Path) -> Thread:
        return XlsxThread(queue, path)


class XlsxThread(Thread):
    def __init__(self, queue: Queue, name: Path):
        super().__init__()
        self.queue = queue
        self.fname = name

    def run(self):
        kinds = ['accel', 'gyro', 'mag', 'baro']
        fresh = NewRows()
        rows_written: dict[str, int] = {}
        writer = ExcelWriter(self.fname, engine='openpyxl')
        print(f"Excel file {self.fname} opened")
        try:
            while True:
                try:
                    data = self.queue.get()
                except ShutDown:
                    break
                for kind, df in zip(kinds, data, strict=True):
                    new = fresh(kind, df)
                    if new.empty:
                        continue
                    # Append below what is already in the sheet (row 0 is the header).
                    written = rows_written.get(kind, 0)
                    new.to_excel(writer, sheet_name=kind, index=False,
                                 header=written == 0, startrow=0 if written == 0 else written + 1)
                    rows_written[kind] = written + len(new)
        finally:
            if not rows_written:
                # openpyxl cannot save a workbook with no sheets.
                writer.book.create_sheet('empty')
            writer.close()  # always flush what was written
            print(f"Excel file {self.fname} closed")
