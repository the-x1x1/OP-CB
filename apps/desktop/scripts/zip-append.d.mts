export declare function appendStoredEntries(
  zipPath: string,
  files: Array<{ name: string; data?: string | Buffer }>,
  when?: Date,
): string[];
