"""Run the real plot-process loop headlessly, with this test playing the UDP loop."""
from __future__ import annotations

import os
import signal
import sys
import threading
import time
from pathlib import Path
from queue import Empty, Queue

import pandas as pd
import pytest

os.environ['MPLBACKEND'] = 'Agg'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matplotlib.pyplot as plt  # noqa: E402
from plot import draw_loop  # noqa: E402


def frames(accel_rows: int, t0: int = 0):
    t = [t0 + i * 20_000 for i in range(50)]
    vec = pd.DataFrame({'tstamp': t, 'x': 0.0, 'y': 0.5, 'z': 0.866})
    accel = vec.iloc[:accel_rows]
    baro = pd.DataFrame({'tstamp': t, 'temperature': 21.5, 'pressure': 1000.0, 'altitude': 110.9})
    return accel, vec.copy(), vec.copy(), baro


# Headless (Agg) has no window to show; that warning is expected here.
@pytest.mark.filterwarnings('ignore:FigureCanvasAgg is non-interactive')
def test_plot_loop_survives_frames_without_accelerometer_data(tmp_path):
    # Regression: the loop read acceldf['tstamp'].iloc[-1] and crashed (IndexError)
    # until the first accelerometer packet arrived.
    request, response, info = Queue(maxsize=1), Queue(), Queue()
    shutdown = threading.Event()
    answered = []

    def udp_side():
        sent = 0
        while sent < 8:
            try:
                request.get(timeout=5)
            except Empty:
                return
            # The first frames carry no accelerometer rows at all.
            response.put(frames(accel_rows=0 if sent < 4 else 50, t0=sent * 1_000_000))
            sent += 1
            answered.append(sent)
        info.put((1.0, 'Kbps', 200.0, 'packets/s'))
        time.sleep(0.5)
        plt.close('all')  # the user closes the window

    feeder = threading.Thread(target=udp_side)
    feeder.start()
    draw_loop('127.0.0.1', request, response, info, shutdown, tmp_path, 'excel', 2000)
    feeder.join(timeout=10)

    assert len(answered) == 8
    assert shutdown.is_set()  # the UDP loop is told the window closed


@pytest.mark.filterwarnings('ignore:FigureCanvasAgg is non-interactive')
def test_ctrl_c_stops_the_plot_loop_and_closes_the_recording(tmp_path):
    # Regression: Ctrl-C raised KeyboardInterrupt inside a Qt callback, where Qt
    # swallowed it, so the plot process never exited.
    request, response, info = Queue(maxsize=1), Queue(), Queue()
    shutdown = threading.Event()

    def udp_side():
        for sent in range(3):
            request.get(timeout=5)
            response.put(frames(accel_rows=50, t0=sent * 1_000_000))
        signal.raise_signal(signal.SIGINT)  # the user presses Ctrl-C

    feeder = threading.Thread(target=udp_side)
    feeder.start()
    before = signal.getsignal(signal.SIGINT)
    draw_loop('127.0.0.1', request, response, info, shutdown, tmp_path, 'excel', 2000)
    feeder.join(timeout=10)

    assert shutdown.is_set()
    assert signal.getsignal(signal.SIGINT) is before  # the caller's handler is restored
