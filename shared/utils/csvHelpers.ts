/**
 * CSV utility functions for safe, consistent CSV exports.
 *
 * - `csvEscape` — Double-quotes a value (escaping inner quotes).
 * - `csvSafe` — Guards against CSV formula injection then escapes.
 * - `downloadCsv` — Creates and triggers a UTF-8 BOM CSV download.
 */

/** Wrap a value in double-quotes, escaping embedded quotes per RFC 4180. */
export function csvEscape(val: string): string {
  return `"${val.replace(/"/g, '""')}"`;
}

/**
 * Sanitise a value for CSV output:
 * 1. Coerce to string (handles null/undefined).
 * 2. Prefix formula-triggering characters (`=`, `+`, `-`, `@`, `\t`, `\r`)
 *    with a leading single-quote so spreadsheet apps treat the cell as text.
 * 3. Double-quote the result.
 */
export function csvSafe(val: unknown): string {
  let s = String(val ?? '');
  // Prevent CSV formula injection: prefix dangerous chars with a tab character
  // (single-quote prefix can itself be double-escaped, tab is safer)
  if (/^[=+\-@\t\r]/.test(s)) s = `\t${s}`;
  return csvEscape(s);
}

/**
 * Trigger a browser download of a CSV string with proper UTF-8 BOM
 * so Excel opens it correctly (including ₹ and other Unicode chars).
 * 
 * Overloads:
 *  - `downloadCsv(filename, csvString)` — Download a pre-formatted CSV string
 *  - `downloadCsv(filename, headers, rows)` — Build CSV from headers + row arrays (auto-safe)
 */
export function downloadCsv(filename: string, csvStringOrHeaders: string | string[], rows?: string[][]): void {
  if (typeof window === 'undefined') return;
  let csvString: string;
  if (Array.isArray(csvStringOrHeaders)) {
    // Build CSV from headers + rows arrays
    const headerLine = csvStringOrHeaders.map(csvSafe).join(',');
    const dataLines = (rows || []).map(row => row.map(csvSafe).join(','));
    csvString = [headerLine, ...dataLines].join('\n');
  } else {
    csvString = csvStringOrHeaders;
  }
  const blob = new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
