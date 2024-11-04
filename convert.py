# Usage: python convert.py path-to-data
#   Converts all (relevant) Excel files to a SQLite DB in the current directory
# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "openpyxl",
#     "pandas",
#     "sqlalchemy",
# ]
# ///

import sys
import re
from pathlib import Path
import pandas as pd
from typing import Dict, List, Tuple
import numpy as np

def sanitize_name(name: str) -> str:
    """Sanitize string to valid SQLite identifier.

    Args:
        name: Original string to sanitize

    Returns:
        Sanitized string with leading numbers removed and special chars replaced
    """
    # Remove leading numbers and spaces, replace special chars with single _
    clean_name = re.sub(r'^\d+\s*', '', str(name))
    return re.sub(r'[^a-zA-Z0-9]+', '_', clean_name).strip('_')

def get_column_metadata(df: pd.DataFrame, col: str) -> Tuple[str, int, str, str]:
    """Generate metadata for a single column.

    Args:
        df: Input dataframe
        col: Column name

    Returns:
        Tuple of (dtype, nunique, top5 value-frequency string, category)
    """
    dtype = str(df[col].dtype)
    nunique = df[col].nunique()

    # Get value counts as percentages
    val_counts = df[col].value_counts(normalize=True)

    # Filter values with >1% frequency, always keep top 2
    top_vals = val_counts.head(2)
    remaining = val_counts.iloc[2:][val_counts.iloc[2:] > 0.01]
    top_vals = pd.concat([top_vals, remaining]).head(5)

    top5_str = '\n'.join(f"{val}\t{freq:.1%}" for val, freq in top_vals.items())

    # Determine category
    if dtype in ('int64', 'float64'):
        category = 'numeric'
    elif nunique <= 12 or (not any(' ' in str(val) for val in top_vals.index) and nunique <= 25):
        category = 'enum'
    else:
        category = 'embedding' if any(' ' in str(val) for val in top_vals.index) else 'string-diff'

    return dtype, nunique, top5_str, category

def process_excel_files(base_path: str) -> None:
    """Process Excel files recursively and load into SQLite + generate metadata.

    Args:
        base_path: Root directory to search for Excel files
    """
    db_path = 'data.db'
    metadata_rows: List[Dict] = []

    for excel_file in Path(base_path).rglob('*.xlsx'):
        table_name = sanitize_name(excel_file.stem)

        try:
            df = pd.read_excel(excel_file, sheet_name=0)
            # Sanitize column names
            df.columns = [sanitize_name(col) for col in df.columns]

            df.to_sql(table_name, f'sqlite:///{db_path}', if_exists='replace', index=False)
            print(f"Processed {excel_file.name} -> {table_name}")

            # Generate metadata for each column
            for col in df.columns:
                dtype, nunique, top5, category = get_column_metadata(df, col)
                metadata_rows.append({
                    'table': table_name,
                    'column': col,
                    'type': dtype,
                    'nunique': nunique,
                    'top5': top5,
                    'category': category
                })

        except Exception as e:
            print(f"Error processing {excel_file}: {e}")

    # Create metadata CSV
    pd.DataFrame(metadata_rows).to_csv('metadata.csv', index=False)

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: python convert.py <path-to-data>")
        sys.exit(1)

    process_excel_files(sys.argv[1])
