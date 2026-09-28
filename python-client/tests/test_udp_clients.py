"""Client bookkeeping in the UDP loop."""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

os.environ['MPLBACKEND'] = 'Agg'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from udp_thread import reap_closed  # noqa: E402


def fake_client():
    joined = []
    process = SimpleNamespace(join=lambda: joined.append(True))
    return SimpleNamespace(shutdown=threading.Event(), process=process, joined=joined)


def test_closed_windows_are_reaped_and_remembered():
    a, b = fake_client(), fake_client()
    clients, closed = {'10.0.0.1': a, '10.0.0.2': b}, set()

    assert reap_closed(clients, closed) is False  # nothing closed yet
    a.shutdown.set()  # the user closes the first window
    assert reap_closed(clients, closed) is False  # one board is still open
    assert list(clients) == ['10.0.0.2']
    assert closed == {'10.0.0.1'}
    assert a.joined == [True]

    b.shutdown.set()
    assert reap_closed(clients, closed) is True  # last window closed: time to exit
    assert clients == {}


def test_no_clients_yet_is_not_a_reason_to_exit():
    assert reap_closed({}, set()) is False
