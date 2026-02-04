#!/usr/bin/env python3
"""
Select the shortest 50% of rows by length of column 0, preserving original order.
"""

import argparse
import csv
from pathlib import Path


def read_lengths(path: Path) -> list[int]:
    lengths: list[int] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            if not row:
                lengths.append(0)
                continue
            lengths.append(len(row[0]))
    return lengths


def pick_indices(lengths: list[int], n_keep: int) -> set[int]:
    order = sorted(range(len(lengths)), key=lambda i: (lengths[i], i))
    return set(order[:n_keep])


def write_selected(input_path: Path, output_path: Path, selected: set[int]) -> int:
    count = 0
    with input_path.open("r", encoding="utf-8", newline="") as fin, output_path.open(
        "w", encoding="utf-8", newline=""
    ) as fout:
        reader = csv.reader(fin)
        writer = csv.writer(fout)
        for idx, row in enumerate(reader):
            if idx in selected:
                writer.writerow(row)
                count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write the shortest 50% of rows (by column 0 length) to a CSV."
    )
    parser.add_argument(
        "input_csv",
        nargs="?",
        default="out/examples_rewrite2_csv/all.csv",
        help="Input CSV path (default: out/examples_rewrite2_csv/all.csv)",
    )
    parser.add_argument(
        "output_csv",
        nargs="?",
        default=None,
        help="Output CSV path (default: <input_dir>/short.csv)",
    )
    args = parser.parse_args()

    input_path = Path(args.input_csv)
    if args.output_csv:
        output_path = Path(args.output_csv)
    else:
        output_path = input_path.parent / "short.csv"

    lengths = read_lengths(input_path)
    n_keep = len(lengths) // 2
    selected = pick_indices(lengths, n_keep)
    write_selected(input_path, output_path, selected)


if __name__ == "__main__":
    main()
