from __future__ import annotations

import queue
import socket
from dataclasses import dataclass
from multiprocessing import Event, Process, Queue
from pathlib import Path
from typing import Any, Optional

from datarate import DataRate
from decoder import DataBuffer, decode_packet
from plot import SaveKind, draw_loop

# A plot process gets this long to finish its recording file after Ctrl-C.
CHILD_EXIT_TIMEOUT_S = 10
# Longest the receive loop waits for a packet before checking for Ctrl-C and closed windows.
RECV_TIMEOUT_S = 0.5


@dataclass
class Client:
    accel: DataBuffer
    gyro: DataBuffer
    mag: DataBuffer
    baro: DataBuffer
    request: Queue  # Plot process asks for data: Queue[int]
    response: Queue  # UDP loop sends (accel, gyro, mag, baro) DataFrames
    info: Queue  # UDP loop sends data-rate info: (bitrate, unit, packetrate, unit)
    shutdown: Any  # Plot process signals its window closed: Event
    process: Process
    datarate: DataRate
    last_tstamp: Optional[int] = None  # Last device timestamp (µs since boot)


def udp_loop(
    host: str,
    port: int,
    datapath: Path = Path.cwd() / 'data',
    savekind: SaveKind = 'excel',
    winsize: int = 2000,
):
    """Receive packets and give each board (by IP) its own plot window process.

    Args:
        host (str): Address to bind to.
        port (int): Port to listen for UDP packets.
        datapath (Path, optional): Path to store data files. Defaults to Path.cwd() / 'data'.
        savekind (SaveKind, optional): Kind of data storage: 'excel' or 'netcdf'. Defaults to 'excel'.
        winsize (int, optional): Window size in milliseconds for displaying data. Defaults to 2000.
    """
    clients: dict[str, Client] = {}
    closed: set[str] = set()  # boards whose window the user closed
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((host, port))
    # Wake up regularly: a blocking receive cannot be interrupted by Ctrl-C on
    # Windows, and closed windows must be noticed even when no packets arrive.
    sock.settimeout(RECV_TIMEOUT_S)
    print(f"[UDP] Listening for UDP packets on {host}:{port}")

    try:
        while True:
            try:
                # Larger than one packet so an oversized datagram is rejected by
                # decode_packet's length check instead of raising on Windows.
                packet, addr = sock.recvfrom(2048)
            except TimeoutError:
                packet = None
            except OSError as e:
                print(f"[UDP] Receive error: {e}")
                continue
            if reap_closed(clients, closed):
                print("[UDP] All clients disconnected, exiting")
                break
            if packet is None:
                continue
            # A board is identified by its IP; the source port changes on reboot.
            loc = addr[0]
            if loc in closed:
                continue
            client = clients.get(loc)
            if client is None:
                client = start_client(loc, datapath, savekind, winsize)
                clients[loc] = client
                print(f"[UDP] New client connected: {loc}")

            rate = client.datarate.update(len(packet))
            if rate is not None:
                client.info.put_nowait(rate)
            tstamp = decode_packet(packet, client.accel, client.gyro, client.mag, client.baro)
            # The board rebooted if its µs clock jumped back by over a second:
            # drop the old session so plots do not mix two timelines.
            if tstamp is not None:
                if client.last_tstamp is not None and tstamp < client.last_tstamp - 1_000_000:
                    print(f"[UDP] Client {loc} restarted, clearing buffers")
                    for buf in (client.accel, client.gyro, client.mag, client.baro):
                        buf.clear()
                client.last_tstamp = tstamp

            # Answer a pending data request from the plot process.
            try:
                client.request.get_nowait()
            except queue.Empty:
                continue
            client.response.put_nowait((
                client.accel.to_dataframe(['tstamp', 'x', 'y', 'z']),
                client.gyro.to_dataframe(['tstamp', 'x', 'y', 'z']),
                client.mag.to_dataframe(['tstamp', 'x', 'y', 'z']),
                client.baro.to_dataframe(['tstamp', 'temperature', 'pressure', 'altitude']),
            ))
    except KeyboardInterrupt:
        print("[UDP] Interrupted by user")
    finally:
        sock.close()
        stop_clients(clients.values())


def reap_closed(clients: dict[str, Client], closed: set[str]) -> bool:
    """Forget boards whose window the user closed; True once the last one is gone."""
    done = [loc for loc, client in clients.items() if client.shutdown.is_set()]
    for loc in done:
        clients.pop(loc).process.join()
        closed.add(loc)
        print(f"[UDP] Client {loc} disconnected")
    return bool(done) and not clients


def start_client(loc: str, datapath: Path, savekind: SaveKind, winsize: int) -> Client:
    request, response, info, shutdown = Queue(maxsize=1), Queue(), Queue(), Event()
    # Data this process sends may never be read if the plot process is gone;
    # do not let unsent data block this process from exiting.
    response.cancel_join_thread()
    info.cancel_join_thread()
    process = Process(target=draw_loop, args=(
        loc, request, response, info, shutdown, datapath, savekind, winsize))
    process.start()
    return Client(
        DataBuffer(maxlen=winsize), DataBuffer(maxlen=winsize),
        DataBuffer(maxlen=winsize), DataBuffer(maxlen=winsize),
        request, response, info, shutdown, process, DataRate(update_rate=1.0),
    )


def stop_clients(clients) -> None:
    """Wait for plot processes to close their windows and recordings; stop stragglers."""
    for client in clients:
        client.process.join(timeout=CHILD_EXIT_TIMEOUT_S)
        if client.process.is_alive():
            print(f"[UDP] Plot process {client.process.pid} did not exit; terminating")
            client.process.terminate()
            client.process.join()
