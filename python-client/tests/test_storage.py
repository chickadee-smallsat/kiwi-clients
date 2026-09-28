"""The Excel and NetCDF loggers must save every sample exactly once.

The plot process hands the loggers its whole display window on every frame,
so consecutive windows overlap; these tests feed such windows through the real
writer threads and read the files back.
"""
from __future__ import annotations

import sys
from pathlib import Path
from queue import Queue

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storesystem import NewRows  # noqa: E402


def window(start: int, stop: int, offset_us: int = 0) -> list[pd.DataFrame]:
    """Accel, gyro, mag and baro frames for samples start..stop-1 (20 ms apart)."""
    t = [offset_us + i * 20_000 for i in range(start, stop)]
    vec = pd.DataFrame({'tstamp': t, 'x': [float(i) for i in range(start, stop)], 'y': 0.0, 'z': 1.0})
    baro = pd.DataFrame({'tstamp': t, 'temperature': 21.5, 'pressure': 1000.0, 'altitude': 110.9})
    return [vec, vec.copy(), vec.copy(), baro]


def test_new_rows_skips_what_was_already_saved():
    fresh = NewRows()
    assert len(fresh('accel', window(0, 100)[0])) == 100
    assert list(fresh('accel', window(50, 150)[0])['x']) == [float(i) for i in range(100, 150)]
    assert fresh('accel', window(60, 150)[0]).empty


def test_new_rows_restarts_after_a_board_reboot():
    fresh = NewRows()
    fresh('accel', window(1000, 1100)[0])
    after_reboot = fresh('accel', window(0, 10)[0])
    assert len(after_reboot) == 10


def run_writer(thread_cls, path: Path, windows: list[list[pd.DataFrame]]) -> None:
    queue: Queue = Queue()
    thread = thread_cls(queue, path)
    thread.start()
    for w in windows:
        queue.put(w)
    queue.shutdown()  # finish the queued items, then stop
    thread.join(timeout=30)
    assert not thread.is_alive()


OVERLAPPING = [window(0, 100), window(50, 150), window(100, 250)]


def test_excel_log_has_every_sample_once(tmp_path):
    pytest.importorskip('openpyxl')
    from xlsx_thread import XlsxThread

    path = tmp_path / 'log.xlsx'
    run_writer(XlsxThread, path, OVERLAPPING)
    for sheet in ('accel', 'gyro', 'mag', 'baro'):
        df = pd.read_excel(path, sheet_name=sheet)
        assert list(df['tstamp']) == [i * 20_000 for i in range(250)], sheet
    assert list(pd.read_excel(path, sheet_name='accel')['x']) == [float(i) for i in range(250)]


def test_netcdf_log_has_every_sample_once(tmp_path):
    netcdf = pytest.importorskip('netCDF4')
    from nc_thread import NcThread

    path = tmp_path / 'log.nc'
    run_writer(NcThread, path, OVERLAPPING)
    with netcdf.Dataset(path) as ds:
        for group in ('accel', 'gyro', 'mag', 'baro'):
            assert list(ds.groups[group].variables['tstamp'][:]) == [i * 20_000 for i in range(250)], group


def _save_button_axes():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    return plt.figure().add_subplot()


@pytest.mark.parametrize('kind', ['excel', 'netcdf'])
def test_closing_a_recording_writes_everything_already_queued(tmp_path, kind):
    # Regression: close() used queue.shutdown(immediate=True), which throws
    # away queued frames that the writer thread has not reached yet.
    if kind == 'excel':
        pytest.importorskip('openpyxl')
        from xlsx_thread import XlsxDataset as Store
    else:
        pytest.importorskip('netCDF4')
        from nc_thread import NcDataset as Store

    store = Store(tmp_path, _save_button_axes())
    store.callback(None)  # "Save" pressed: recording starts
    for start in range(0, 2000, 100):  # queue many frames at once
        store.update(window(start, start + 100))
    store.close()

    (path,) = tmp_path.iterdir()
    if kind == 'excel':
        assert len(pd.read_excel(path, sheet_name='accel')) == 2000
    else:
        import netCDF4
        with netCDF4.Dataset(path) as ds:
            assert len(ds.groups['accel'].variables['tstamp'][:]) == 2000
