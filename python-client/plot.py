# %%
from contextlib import suppress
from datetime import datetime
import os
from pathlib import Path
from queue import Empty, Full
import signal
from typing import Any, Literal
import matplotlib
from time import perf_counter_ns
from matplotlib.gridspec import GridSpec
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from multiprocessing import Queue
from decoder import latest_timestamp, xyz_to_rtp

from nc_thread import NcDataset
from xlsx_thread import XlsxDataset

matplotlib.rcParams.update({'mathtext.fontset': 'cm'})
matplotlib.rc(
    'font',
    family='serif',
    serif=['Times New Roman'],
)

# Qt backend (pyside6) for the interactive window, unless MPLBACKEND says otherwise
# (the tests run headless with MPLBACKEND=Agg).
if 'MPLBACKEND' not in os.environ:
    matplotlib.use('QtAgg')

# %%
SaveKind = Literal['excel', 'netcdf']

# %%


def get_sel(df: pd.DataFrame, now, winsize: int):
    sel = df['tstamp'] > (now - winsize * 1e3)
    return sel


# %%
DPI = 96
FIG_WID = 800 / DPI
FIG_HEI = 600 / DPI


def draw_loop(
        source: Any,
        request: Queue,
        response: Queue,
        info: Queue,
        shutdown: Any,
        datapath: Path = Path.cwd() / 'data',
        savekind: SaveKind = 'netcdf',
        winsize: int = 1000,
    ):
    """A drawing loop that requests data from the UDP server :func:`udp_loop`
    and plots the data in real-time.

    Args:
        source (Any): Device IP address
        request (Queue): Request data from UDP server by putting any value in this queue
        response (Queue): Response from UDP server: tuple of DataFrames (accel, gyro, mag, baro)
        info (Queue): Info queue from UDP server: (source: ip, datetime, bitrate, byteunit, packrate, packunit)
        shutdown (Event): Signal to UDP server that the drawing loop is shutting down
        datapath (Path, optional): Path to store NetCDF files. Defaults to current working directory / 'data'.
        savekind (SaveKind, optional): Kind of file to save data. Defaults to 'netcdf'.
        winsize (int, optional): Window size in milliseconds for displaying data. Defaults to 1000.
    """
    # The UDP source address
    ip = source
    # Turn off interactive mode for dynamic plotting
    plt.ioff()
    # The grid layout for the subplots
    # ___________________________
    # | Accel |         |       |
    # |       |         |       |
    # |_______| Accel θ | Mag θ |
    # | Gyro  |         |       |
    # |       |         |       |
    # |_______|_________|_______|
    # | Mag   |                 |
    # |       |                 |
    # |_______|     Mag φ       |
    # | Temp  |    Compass      |
    # |_______|                 |
    # | Pres  |                 |
    # | Alt   |                 |
    # |_______|_________________|
    grid = GridSpec(
        7, 9,
        height_ratios=[0.2, 0.1, 1, 1, 1, 1, 1], # Legend, 5 line plots
        width_ratios=[1]*4 + [0.2] + [1]*4, # Line plots, gap, polar plots
        hspace=0.05, wspace=0.3
    )
    START = 2 # Start row for plots
    fig = plt.figure(figsize=(FIG_WID, FIG_HEI), dpi=DPI, animated=True)
    # Set window title
    fig.canvas.manager.set_window_title(f'Kiwi Mainboard Sensor Data ({ip})')  # type: ignore
    fig.suptitle('Kiwi Mainboard Sensor Data', fontsize=16, fontweight='bold')
    fignum = fig.number
    # Display FPS and data rate here
    curtime = fig.text(
        0.95, 0.95, "Waiting for data...",
        fontsize=8, ha='right', va='center'
    )

    # First row for button, use the full width
    button_ax = fig.add_subplot(grid[0, 3:6])
    if savekind == 'excel':
        datastor = XlsxDataset(datapath, button_ax)
    elif savekind == 'netcdf':
        datastor = NcDataset(datapath, button_ax)
    else:
        raise ValueError(f"Invalid savekind: {savekind}")

    # First row for legend, use the left section only
    legend_ax = fig.add_subplot(grid[START-1, 1:3])
    
    axs = []
    # Create accel, gyro, mag axes
    for i in range(3):
        ax = fig.add_subplot(grid[i+START, :4], sharex=axs[0] if axs else None)
        ax.autoscale(enable=True, axis='y')
        axs.append(ax)
    axs = np.asarray(axs)

    # Create polar plots for accel and mag orientation
    accel_theta = fig.add_subplot(grid[START:START+2, 5:7], projection='polar')
    mag_theta = fig.add_subplot(grid[START:START+2, 7:9], projection='polar')
    mag_phi = fig.add_subplot(grid[START+2:, 5:], projection='polar')
    accel_theta.set_xlim(-np.pi/2, np.pi/2)
    accel_theta.set_ylim(0, 1.1)
    accel_theta.set_yticklabels([])
    accel_theta.text(
        1.05, 0.5, 'Acceleration θ',
        fontsize=10, ha='center', va='center', transform=accel_theta.transAxes, rotation=270
    )
    mag_theta.set_xlim(-np.pi/2, np.pi/2)
    mag_theta.set_ylim(0, 1.1)
    mag_theta.set_yticklabels([])
    mag_theta.text(
        1.05, 0.5, 'Magnetic Field θ',
        fontsize=10, ha='center', va='center', transform=mag_theta.transAxes, rotation=270
    )
    mag_phi.set_xlim(0, 2*np.pi)
    mag_phi.set_ylim(0, 1.1)
    mag_phi.set_yticklabels([])
    magphi_tx = mag_phi.text(
        1.1, 0.5, 'Magnetic Field φ',
        fontsize=10, ha='center', va='center', transform=mag_phi.transAxes, rotation=270
    )

    # Create temperature axis
    temp_ax = fig.add_subplot(grid[START+3, :4], sharex=axs[0])
    temp_ax.autoscale(enable=True, axis='y')
    temp_ax.set_ylabel('°C', fontsize=12)

    # Create pressure and altitude axes
    pres_ax = fig.add_subplot(grid[START+4, :4], sharex=axs[0])
    pres_ax.autoscale(enable=True, axis='y')
    alt_ax = pres_ax.twinx()
    alt_ax.autoscale(enable=True, axis='y')
    pres_ax.set_ylabel('hPa', fontsize=12)
    alt_ax.set_ylabel('m', fontsize=12, color='r')
    pres_ax.set_xlabel('Time (s)', fontsize=12)

    fig.subplots_adjust()

    # Turn off x tick labels for all but the bottom plot
    for ax, unit in zip(axs, ('g', '°/s', 'mG'), strict=True):
        ax.set_ylabel(unit, fontsize=12)
        ax.tick_params(axis='x', which='both', labelbottom=False)

    temp_ax.tick_params(axis='x', which='both', labelbottom=False)
    alt_ax.tick_params(axis='x', which='both', labelbottom=False)

    # Create empty lines for updating data
    lines = []
    for mid, axm in enumerate(axs):
        lines.append([])
        lines[mid].append(
            axm.plot([], [], label='X', color='red', alpha=0.5, linewidth=0.75)[0])
        lines[mid].append(
            axm.plot([], [], label='Y', color='green', alpha=0.5, linewidth=0.75)[0])
        lines[mid].append(
            axm.plot([], [], label='Z', color='blue', alpha=0.5, linewidth=0.75)[0])
        lines[mid].append(
            axm.plot([], [], color='black', linestyle='--',
                     linewidth=0.75, alpha=0.5)[0]
        )

    accel_line, = accel_theta.plot([], [], color='blue', linewidth=2)
    mag_theta_line, = mag_theta.plot([], [], color='blue', linewidth=2)
    mag_phi_line, = mag_phi.plot([], [], color='blue', linewidth=2)

    temp_line, = temp_ax.plot(
        [], [], label='Temperature', color='k', alpha=0.8, linewidth=0.75)
    pres_line, = pres_ax.plot([], [], label='Pressure',
                              color='b', alpha=0.8, linewidth=0.75)
    alt_line, = alt_ax.plot([], [], label='Altitude',
                            color='r', alpha=0.8, linewidth=0.75)
    
    # Create legend
    legend_ax.legend(
        handles=lines[0],
        labels=['X', 'Y', 'Z', '|R|'],
        loc='center',
        ncol=4,
        fontsize=12,
        frameon=False
    )
    legend_ax.set_axis_off()

    fig.show()

    # Update the figure once to render the window
    fig.canvas.draw()
    fig.canvas.flush_events()

    last = perf_counter_ns()  # last time we printed info
    loop_count = 0  # Number of loops since last info print
    rq_time = 0  # Total request-response time since last info print

    # Ctrl-C usually lands while Qt is running a callback, and Qt swallows the
    # KeyboardInterrupt raised there. Record it instead and stop on the next pass.
    interrupted = False

    def on_sigint(*_):
        nonlocal interrupted
        interrupted = True

    previous_sigint = signal.signal(signal.SIGINT, on_sigint)

    try:
        while True:  # Main loop
            fig.canvas.draw_idle()
            fig.canvas.flush_events()
            if interrupted:
                print(f"[{ip}] Interrupted by user")
                break
            # Stop when the window has been closed
            if fignum not in plt.get_fignums():
                break
            # Ask the UDP loop for the latest window (the request queue holds one request).
            with suppress(Full):  # a request is already pending
                request.put_nowait(1)
            rq_start = perf_counter_ns()
            try:
                frames = response.get(timeout=1.0)
            except Empty:
                continue  # no packets from this board in the last second
            except InterruptedError:
                continue  # Ctrl-C during the wait (Windows); handled at the top of the loop
            rq_end = perf_counter_ns()
            datastor.update(frames)
            acceldf, gyrodf, magdf, barodf = frames
            # Plot relative to the newest sample of whichever sensors have data.
            now = latest_timestamp(acceldf, gyrodf, magdf, barodf)
            if now is None:
                continue
            # Process the 3-axis sensor data
            for aid, (lline, ax, df) in enumerate(zip(lines, axs, (acceldf, gyrodf, magdf), strict=True)):
                # Select data between now and now - window size
                sel = get_sel(df, now, winsize)
                tstamp = df['tstamp'][sel] * 1e-6  # µs -> s
                lline[0].set_data(tstamp, df['x'][sel])  # Plot X
                lline[1].set_data(tstamp, df['y'][sel])  # Plot Y
                lline[2].set_data(tstamp, df['z'][sel])  # Plot Z
                # Compute |R|, θ, φ
                r, t, p = xyz_to_rtp(
                    df['x'][sel].to_numpy(),
                    df['y'][sel].to_numpy(),
                    df['z'][sel].to_numpy()
                )
                lline[3].set_data(tstamp, r)  # Plot |R|
                # Update polar plots from the newest sample
                if len(r) > 0:
                    t = t[-1]  # theta
                    p = p[-1]  # phi
                    if aid == 0:  # accel
                        accel_line.set_data([t, t], [0, 1])
                    elif aid == 2:  # mag
                        mag_theta_line.set_data([t, t], [0, 1])
                        mag_phi_line.set_data([p, p], [0, 1])
                        magphi_tx.set_text(
                            f'Azimuthal Angle (φ): {np.degrees(p):.1f}°')
                ax.relim()  # Recompute limits
                ax.autoscale_view()  # Autoscale
            # Process barometer data
            sel = get_sel(barodf, now, winsize)
            tstamp = barodf['tstamp'][sel] * 1e-6  # µs -> s
            temp_line.set_data(tstamp, barodf['temperature'][sel])  # Temperature
            pres_line.set_data(tstamp, barodf['pressure'][sel])  # Pressure
            alt_line.set_data(tstamp, barodf['altitude'][sel])  # Altitude
            for axis in (temp_ax, pres_ax, alt_ax):
                axis.relim()
                axis.autoscale_view()
            # Update x limits
            alt_ax.set_xlim(now*1e-6-winsize*1e-3, now*1e-6)
            loop_count += 1
            rq_time += rq_end - rq_start
            # Print stats whenever the UDP loop reports a new data rate
            try:
                brate, bunit, prate, punit = info.get_nowait()
            except Empty:
                continue
            tick = perf_counter_ns()
            loop_time = (tick - last) / loop_count  # Average loop time in ns
            rq_ms = rq_time / loop_count / 1e6  # Average request-response time in ms
            loop_count = 0
            rq_time = 0
            last = tick
            outtxt = f"FPS: {1e9/loop_time:.2f}, UDP Rate: {brate:.2f} {bunit} ({prate:.2f} {punit}), Req-Res Time: {rq_ms:.2f} ms"
            stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{stamp}] Source: {ip}, {outtxt}")
            curtime.set_text(outtxt.replace(', ', '\n'))
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        # Always tell the UDP loop and finish the recording file, however we exit.
        plt.close('all')
        shutdown.set()
        datastor.close()
        print(f"[{ip}] Done receiving data")
