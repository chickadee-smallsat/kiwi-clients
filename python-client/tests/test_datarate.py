"""Unit tests for DataRate unit scaling."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import datarate  # noqa: E402


def rate_for(total_bytes: int, monkeypatch) -> tuple:
    clock = iter([0, 2_000_000_000])  # first update, second update 2 s later
    monkeypatch.setattr(datarate, 'perf_counter_ns', lambda: next(clock))
    dr = datarate.DataRate(update_rate=1.0)
    dr.update(0)
    return dr.update(total_bytes)


def test_bps(monkeypatch):
    rate, unit, _, _ = rate_for(100, monkeypatch)
    assert unit == 'bps' and rate == 400


def test_kbps(monkeypatch):
    rate, unit, _, _ = rate_for(10_000, monkeypatch)
    assert unit == 'Kbps' and abs(rate - 40_000 / 1024) < 1e-9


def test_mbps_is_reachable(monkeypatch):
    # Regression: the Kbps branch used to be checked first, so Mbps never showed.
    rate, unit, _, _ = rate_for(1_000_000, monkeypatch)
    assert unit == 'Mbps' and abs(rate - 4_000_000 / 1024 / 1024) < 1e-9
