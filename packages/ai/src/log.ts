// Progress lines: what residents do and say. The long-running service writes them to stdout, so
// hosts that treat stderr as errors (Railway) show only real failures as errors; one-shot CLI
// commands keep them on stderr, so their JSON on stdout stays clean. Failures always use
// console.error.
let toStdout = false;

export const logToStdout = () => {
  toStdout = true;
};

export const info = (line: string) => (toStdout ? console.log(line) : console.error(line));
