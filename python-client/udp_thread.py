from __future__ import annotations
from datetime import datetime
from pathlib import Path
import socket
import struct
from time import perf_counter_ns
from multiprocessing import Queue, Process, Event
from threading import Thread
from typing import Any, Optional, Tuple
from dataclasses import dataclass
from plot import draw_loop

from pandas import DataFrame

from decoder import DataBuffer, SINGLE_MEASUREMENT_SIZE, decode_packet

# %%


@dataclass
class Client:
    accel: DataBuffer
    gyro: DataBuffer
    mag: DataBuffer
    baro: DataBuffer
    request: Queue # Plot thread requests data: Queue[int]
    response: Queue # UDP thread sends data: Queue[Tuple[DataFrame, DataFrame, DataFrame, DataFrame]]
    info: Queue # UDP thread sends info: Queue[Tuple[float, str, float, str]]
    shutdown: Any # Plot thread signals window closed: Event
    datarate: DataRate


class DataRate:
    def __init__(self, update_rate: float = 2.0):
        self.bytecount = 0
        self.count = 0
        self.last = None  # Last timestamp for calculating data rate
        self.update_rate = update_rate
        self.start = perf_counter_ns()

    def update(self, num_samples: int = 1) -> Optional[Tuple[float, str, float, str]]:
        now = perf_counter_ns()
        self.bytecount += num_samples
        self.count += 1
        if self.last is None:
            self.last = now
            return
        elapsed = (now - self.last) / 1e9
        if elapsed > self.update_rate:  # Update every second
            datarate = self.bytecount * 8 / elapsed
            packrate = self.count / elapsed
            packunit = 'packets/s'
            self.last = now
            self.bytecount = 0
            self.count = 0
            dataunit = 'bps'
            if datarate > 1024:
                datarate /= 1024
                dataunit = 'Kbps'
            elif datarate > 1024*1024:
                datarate /= 1024*1024
                dataunit = 'Mbps'
            if packrate > 1000:
                packrate /= 1000
                packunit = 'Kpackets/s'
            return (datarate, dataunit, packrate, packunit)

        return None
# %% UDP server loop


def udp_loop(host: str, port: int, datapath: Path = Path.cwd() / 'data', winsize: int = 2000):
    """UDP client loop.

    Args:
        host (str): Address to bind to.
        port (int): Port to listen for UDP packets.
        winsize (int, optional): Window size in milliseconds for displaying data. Defaults to 2000.
    """
    # Dictionary of clients
    clients: dict[Any, Client] = {}
    # Dictionary of plot processes
    threads: dict[Any, Process] = {}
    # Set of disconnected clients
    closed: set = set()
    # Create UDP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((host, port)) # Bind to address and port
    print(f"[UDP] Listening for UDP packets on {host}:{port}")

    while True: # Main event loop
        # Try to receive UDP packet
        try:
            temp, loc = sock.recvfrom(SINGLE_MEASUREMENT_SIZE)
            # New client connected
            if loc not in clients and loc not in closed:
                # Create queues and event to communicate with plot thread for client
                request = Queue(maxsize=1)
                response = Queue()
                info = Queue()
                shutdown = Event()
                client = Client(
                    DataBuffer(maxlen=winsize),
                    DataBuffer(maxlen=winsize),
                    DataBuffer(maxlen=winsize),
                    DataBuffer(maxlen=winsize),
                    request,
                    response,
                    info,
                    shutdown,
                    DataRate(update_rate=1.0)
                )
                # Start plot thread for client
                proc = Process(None, draw_loop, args=(
                    loc, request, response, info, shutdown, datapath, winsize))
                proc.start()
                threads[loc] = proc
                clients[loc] = client
                print(f"[UDP] New client connected: {loc[0]}:{loc[1]}")
        except KeyboardInterrupt:
            print("[UDP] Interrupted by user")
            sock.close()
            break
        except Exception as e:
            print(f"[UDP] Connection lost: {e}")
            continue
        # Process received packet
        try:
            client = clients[loc] # Retrieve the client communication objects
            info = client.datarate.update(len(temp)) # Update data rate
            if info is not None: # Send data rate info to plot thread
                client.info.put_nowait(info)
            # Decode the packet and store data in buffers
            decode_packet(
                temp,
                client.accel, client.gyro,
                client.mag, client.baro
            )
            # Handle client disconnection
            if client.shutdown.is_set():
                clients.pop(loc)
                threads.pop(loc).join()
                closed.add(loc)
                print(f"[UDP] Client {loc[0]}:{loc[1]} disconnected")
                if len(clients) == 0:
                    print("[UDP] All clients disconnected, exiting")
                    sock.close()
                    break
            # Handle data request from plot thread
            elif client.request.get_nowait() is not None:
                # Prepare dataframes and send to plot thread
                accel = client.accel.to_dataframe(
                    ['tstamp', 'x', 'y', 'z'])
                gyro = client.gyro.to_dataframe(['tstamp', 'x', 'y', 'z'])
                mag = client.mag.to_dataframe(['tstamp', 'x', 'y', 'z'])
                baro = client.baro.to_dataframe(
                    ('tstamp', 'temperature', 'pressure', 'altitude'))
                client.response.put_nowait((accel, gyro, mag, baro))
        except struct.error as e:
            # type: ignore
            print(
                f"[UDP] Error unpacking data: {e}, received data ({len(temp)}): {temp}")
            continue
        except Exception as e:
            pass
        except KeyboardInterrupt:
            print("[UDP] Interrupted by user")
            sock.close()
            break
