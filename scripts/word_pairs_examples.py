#!/usr/bin/env python3
"""
Write rows whose column 0 contains exactly one space to a CSV, preserving order.
"""

import argparse
import csv
from pathlib import Path


def is_pair(text: str) -> bool:
    cleaned = text.strip()
    return cleaned.count(" ") == 1


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Filter rows where column 0 contains exactly one space."
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
        help="Output CSV path (default: <input_dir>/pairs.csv)",
    )
    args = parser.parse_args()

    input_path = Path(args.input_csv)
    output_path = Path(args.output_csv) if args.output_csv else input_path.parent / "pairs.csv"

    with input_path.open("r", encoding="utf-8", newline="") as fin, output_path.open(
        "w", encoding="utf-8", newline=""
    ) as fout:
        reader = csv.reader(fin)
        writer = csv.writer(fout)
        for row in reader:
            if not row:
                continue
            if is_pair(row[0]):
                writer.writerow(row)


if __name__ == "__main__":
    main()
