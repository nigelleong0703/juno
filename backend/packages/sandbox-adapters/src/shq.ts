/** POSIX single-quote a value so it is safe inside a shell command. */
export const shq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
