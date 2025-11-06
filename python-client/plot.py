# %%
from datetime import datetime
from pathlib import Path
from queue import Empty
from threading import Thread
from typing import Any, Tuple
import matplotlib
from time import perf_counter_ns
from matplotlib.axes import Axes
from matplotlib.gridspec import GridSpec
import numpy as np
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt
from multiprocessing import Queue, Event
from decoder import xyz_to_rtp
import warnings
from pandas import DataFrame

from nc_thread import NcDataset

# Ignore matplotlib warnings
warnings.filterwarnings("ignore", category=RuntimeWarning)
matplotlib.rcParams.update({'mathtext.fontset': 'cm'})
matplotlib.rc(
    'font',
    family='serif',
    serif=['Times New Roman'],
)

matplotlib.use('QtAgg')  # Use TkAgg backend for interactive plotting

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
        winsize: int = 1000):
    """A drawing loop that requests data from the UDP server :func:`udp_loop`
    and plots the data in real-time.

    Args:
        source (Any): UDP source address (ip, port)
        request (Queue): Request data from UDP server by putting any value in this queue
        response (Queue): Response from UDP server: tuple of DataFrames (accel, gyro, mag, baro)
        info (Queue): Info queue from UDP server: (source: (ip, port), datetime, bitrate, byteunit, packrate, packunit)
        shutdown (Event): Signal to UDP server that the drawing loop is shutting down
        datapath (Path): Path to store NetCDF files. Defaults to current working directory / 'data'.
        winsize (int, optional): Window size in milliseconds for displaying data. Defaults to 1000.
    """
    # The UDP source address
    ip, port = source
    # Turn off interactie mode for dynamic plotting
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
    fig.canvas.manager.set_window_title(  # type: ignore
        # type: ignore
        f'Kiwi Mainboard Sensor Data ({source[0]}:{source[1]})')
    fig.suptitle('Kiwi Mainboard Sensor Data', fontsize=16, fontweight='bold')
    fignum = fig.number
    # Display FPS and data rate here
    curtime = fig.text(
        0.95, 0.95, "Waiting for data...",
        fontsize=8, ha='right', va='center'
    )

    # First row for button, use the full width
    button_ax = fig.add_subplot(grid[0, 3:6])
    ncfile = NcDataset(datapath, button_ax)

    # First row for legend, use the left section only
    legend_ax = fig.add_subplot(grid[START-1, 1:3])
    
    axs = []
    # Create accel, gyro, mag axes
    for i in range(3):
        if i == 0:
            ax = fig.add_subplot(grid[i+START, :4])
        else:
            ax = fig.add_subplot(grid[i+START, :4], sharex=axs[0])
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
    for (ax, title, unit) in zip(axs, ('Acceleration', 'ω', 'Magnetic Field'), ('g', '°/s', 'μT')):
        ax: Axes = ax
        # ax.set_title(title, fontsize=10, fontweight='bold')
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

    last = perf_counter_ns() # last time we printed info
    loop_count = 0 # Number of loops since last info print
    rq_time = 0 # Total request-response time since last info print
    rq_start = perf_counter_ns() # Initialize to avoid uninitialized variable

    while True: # Main loop
        # Redraw the figure
        try:
            fig.canvas.draw_idle()
            fig.canvas.flush_events()
        except KeyboardInterrupt:
            print(f"[{ip}:{port}] Interrupted by user")
            plt.close('all')
            exit(0)
        # Check if the figure has been closed
        if fignum not in plt.get_fignums():
            break
        # Try to get new data
        try:
            df = None
            # Request new data if the request queue is empty
            # The request queue is size 1, so if UDP is not ready with new data,
            # we skip this iteration.
            # Note: This condition does not happen since a window is spawned
            # when a client connects, and the window is closed when the client disconnects.
            if not request.full():
                rq_start = perf_counter_ns() # Start time of request
                request.put_nowait(1)
            df = response.get(timeout=1.0)
            rq_end = perf_counter_ns() # End time of response
            if df is None:
                continue
            # Probably received the correct data, which is four dataframes
            ncfile.update(df)
            try:
                acceldf, gyrodf, magdf, barodf = df
            except ValueError:
                print(f"Invalid data received: {df}")
                continue
            # Use the last timestamp to synchronize different sensors
            now = acceldf['tstamp'].iloc[-1]
            # Process the 3-axis sensor data
            for aid, (lline, ax, df) in enumerate(zip(lines, axs, (acceldf, gyrodf, magdf))):
                # The lines: X, Y, Z, R
                lline: list = lline
                # The axis
                ax: Axes = ax
                # Select data between now and now - window size
                sel = get_sel(df, now, winsize)
                # Raw selection
                tstamp = df['tstamp'][sel]
                tstamp *= 1e-6  # Convert to s
                lline[0].set_data(tstamp, df['x'][sel]) # Plot X
                lline[1].set_data(tstamp, df['y'][sel]) # Plot Y
                lline[2].set_data(tstamp, df['z'][sel]) # Plot Z
                # Compute |R|, θ, φ
                r, t, p = xyz_to_rtp(
                    df['x'][sel].to_numpy(),
                    df['y'][sel].to_numpy(),
                    df['z'][sel].to_numpy()
                )
                # Plot |R|
                lline[3].set_data(tstamp, r)
                # Update polar plots
                if len(r) > 0:
                    # Use only the last data point
                    t = t[-1] # theta
                    p = p[-1] # phi
                    if aid == 0:  # accel
                        accel_line.set_data([t, t], [0, 1])
                    elif aid == 2:  # mag
                        mag_theta_line.set_data([t, t], [0, 1])
                        mag_phi_line.set_data([p, p], [0, 1])
                        magphi_tx.set_text(
                            f'Azimuthal Angle (φ): {np.degrees(p):.1f}°')
                ax.relim() # Recompute limits
                ax.autoscale_view() # Autoscale
            # Process barometer data
            sel = get_sel(barodf, now, winsize)
            tstamp = barodf['tstamp'][sel]
            tstamp *= 1e-6  # Convert to s
            temp_line.set_data(tstamp, barodf['temperature'][sel]) # Temperature
            pres_line.set_data(tstamp, barodf['pressure'][sel]) # Pressure
            alt_line.set_data(tstamp, barodf['altitude'][sel]) # Altitude
            temp_ax.relim() # Recompute limits
            temp_ax.autoscale_view() # Autoscale
            pres_ax.relim() # Recompute limits
            pres_ax.autoscale_view() # Autoscale
            alt_ax.relim() # Recompute limits
            alt_ax.autoscale_view() # Autoscale
            # Update x limits
            alt_ax.set_xlim(now*1e-6-winsize*1e-3, now*1e-6)
            loop_count += 1 # Increment loop count
            rq_time += rq_end - rq_start # Accumulate request-response time
            now = perf_counter_ns() # Current time after drawing stuff, getting data, processing data and updating plots
            dinfo = info.get_nowait() # Get info from UDP thread
            if dinfo is not None: # If info is available, print it (and other stats)
                loop_time = (now - last) / loop_count # Average loop time in ns
                rq_time = rq_time / loop_count / 1e6 # Average request-response time in ms
                loop_count = 0 # Reset loop count
                last = now # Reset last time
                # Info from UDP thread
                brate, bunit, prate, punit = dinfo
                # Render the text
                outtxt = f"FPS: {1e9/loop_time:.2f}, UDP Rate: {brate:.2f} {bunit} ({prate:.2f} {punit}), Req-Res Time: {rq_time:.2f} ms"
                # Print to console
                now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                print(f"[{now}] Source: {ip}:{port}, {outtxt}")
                # Update the text in the figure
                curtime.set_text(outtxt.replace(', ', '\n'))
                rq_time = 0 # Reset request-response time
        except Empty: # No response from UDP thread
            continue
        except KeyboardInterrupt: # Interrupted by user
            print(f"[{ip}:{port}] Interrupted by user")
            plt.close('all')
            exit(0)
    shutdown.set()
    ncfile.close()
    print(f"[{ip}:{port}] Done receiving data")
