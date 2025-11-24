# %%
from pathlib import Path
from udp_thread import udp_loop

# %%
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(
        description="Client for Kiwi Sensor Data")
    parser.add_argument(
        'port', type=int, help='Port number of the UDP server', default=8099, nargs='?')
    parser.add_argument(
        '--window', type=int, default=2, help='Window size for data display in seconds'
    )
    parser.add_argument(
        '--host', type=str, default='0.0.0.0', help='Listen address (default: 0.0.0.0)'
    )
    parser.add_argument(
        '--datapath', type=Path, default=Path.cwd() / 'data', help='Path to store NetCDF files'
    )
    parser.add_argument(
        '--savekind', type=str, choices=['excel', 'netcdf'], default='excel',
        help='Kind of data storage: excel or netcdf (default: netcdf)'
    )
    args = parser.parse_args()
    winsize = args.window*1000
    if winsize < 1000:
        print(f"Window size {winsize} ms is too small, setting to 1000 ms")
        winsize = 1000
    elif winsize > 10000:
        print(f"Window size {winsize} ms is too large, setting to 10000 ms")
        winsize = 10000
    # Main thread loops here
    udp_loop(
        args.host, args.port,
        datapath=args.datapath,
        winsize=winsize,
        savekind=args.savekind
    )
