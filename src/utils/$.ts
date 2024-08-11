import { exec } from "node:child_process";

export const $ = (command: string) =>
  new Promise<string>((resolve, reject) =>
    exec(command, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout.trim());
    })
  );
