// std/index.ts
// RypeScript Standart Kütüphanesi - Merkezi Modül Giriş Noktası

import { Buffer } from "./buffer.ts";
import { File, fopen, fclose, fread, fwrite, fseek, ftell, remove } from "./fs.ts";
import { Path, basename, dirname, extname, join } from "./path.ts";
import { Process, process, CommandLine, getenv, exit } from "./process.ts";
import {
  write,
  read,
  STDIN_FILENO,
  STDOUT_FILENO,
  STDERR_FILENO,
  print,
  println,
  eprint,
  eprintln,
  readLine,
  Console,
  console,
} from "./io.ts";
import { StringBuilder } from "./stringbuilder.ts";

export {
  Buffer,
  File,
  fopen,
  fclose,
  fread,
  fwrite,
  fseek,
  ftell,
  remove,
  Path,
  basename,
  dirname,
  extname,
  join,
  Process,
  process,
  CommandLine,
  getenv,
  exit,
  write,
  read,
  STDIN_FILENO,
  STDOUT_FILENO,
  STDERR_FILENO,
  print,
  println,
  eprint,
  eprintln,
  readLine,
  Console,
  console,
  StringBuilder,
};
