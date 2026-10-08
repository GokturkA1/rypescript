// std/io.ts
// RypeScript Standart Kütüphanesi - Standart Akışlar, Terminal G/Ç ve Konsol

export declare function write(fd: i32, buf: pointer, count: i64): i64;
export declare function read(fd: i32, buf: pointer, count: i64): i64;

export const STDIN_FILENO: i32 = 0;
export const STDOUT_FILENO: i32 = 1;
export const STDERR_FILENO: i32 = 2;

export function print(text: string): void {
  let len: i64 = text.length as i64;
  write(STDOUT_FILENO, text as pointer, len);
}

export function println(text?: string): void {
  if (text !== null) {
    print(text);
  }
  write(STDOUT_FILENO, "\n" as pointer, 1);
}

export function eprint(text: string): void {
  let len: i64 = text.length as i64;
  write(STDERR_FILENO, text as pointer, len);
}

export function eprintln(text?: string): void {
  if (text !== null) {
    eprint(text);
  }
  write(STDERR_FILENO, "\n" as pointer, 1);
}

export function readLine(): string {
  let cap: number = 64;
  let len: number = 0;
  let buf: pointer = malloc(cap);
  let chBuf: pointer = malloc(1);

  while (true) {
    let n: i64 = read(STDIN_FILENO, chBuf, 1);
    if (n <= 0) {
      break;
    }
    let b: i32 = ptr_read_u8(chBuf, 0);
    if (b == 10) {
      break;
    }
    if (b == 13) {
      continue;
    }

    if (len + 1 >= cap) {
      let newCap: number = cap * 2;
      let newBuf: pointer = malloc(newCap);
      for (let i = 0; i < len; i++) {
        let byteVal: i32 = ptr_read_u8(buf, i);
        ptr_write_u8(newBuf, i, byteVal);
      }
      free(buf);
      buf = newBuf;
      cap = newCap;
    }

    ptr_write_u8(buf, len, b);
    len = len + 1;
  }

  free(chBuf);

  let resultPtr: pointer = malloc(len + 1);
  for (let i = 0; i < len; i++) {
    let byteVal: i32 = ptr_read_u8(buf, i);
    ptr_write_u8(resultPtr, i, byteVal);
  }
  ptr_write_u8(resultPtr, len, 0);
  free(buf);

  return resultPtr as string;
}

export class Console {
  static log(...args: string[]): void {
    let len: number = args.length;
    for (let i: number = 0; i < len; i++) {
      if (i > 0) {
        print(" ");
      }
      print(args[i]);
    }
    println("");
  }

  static error(...args: string[]): void {
    let len: number = args.length;
    for (let i: number = 0; i < len; i++) {
      if (i > 0) {
        eprint(" ");
      }
      eprint(args[i]);
    }
    eprintln("");
  }

  static warn(...args: string[]): void {
    eprint("[WARN] ");
    let len: number = args.length;
    for (let i: number = 0; i < len; i++) {
      if (i > 0) {
        eprint(" ");
      }
      eprint(args[i]);
    }
    eprintln("");
  }

  static write(text: string): void {
    print(text);
  }
}

export class console {
  static log(...args: string[]): void {
    Console.log(...args);
  }

  static error(...args: string[]): void {
    Console.error(...args);
  }

  static warn(...args: string[]): void {
    Console.warn(...args);
  }

  static write(text: string): void {
    print(text);
  }
}

