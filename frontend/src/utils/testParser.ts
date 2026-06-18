/** Extract group number from filename like input_s2_003.txt -> "2" */
export function extractGroupFromFilename(filename: string): string | undefined {
  const m = filename.match(/_s(\d+)[_\-.]/i);
  return m ? m[1] : undefined;
}

/** Extract test index from filename */
export function extractIndexFromFilename(filename: string): number | null {
  const m = filename.match(/[_\-]?(\d+)[_\-.]/) || filename.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
