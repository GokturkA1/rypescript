// std/process.ts
// RypeScript Standart Kütüphanesi - Süreç ve Ortam Yönetimi (Process & CommandLine)

export declare function getenv(name: string): string;
export declare function exit(code: i32): never;

export class CommandLine {
  args: string[];

  constructor() {
    this.args = process.argv;
  }

  static parse(customArgs: string[]): CommandLine {
    let cli = new CommandLine();
    cli.args = customArgs;
    return cli;
  }

  get(index: number): string {
    if (index >= 0 && index < this.args.length) {
      return this.args[index];
    }
    return "";
  }

  hasFlag(flag: string): boolean {
    for (let i = 0; i < this.args.length; i++) {
      if (this.args[i] === flag) {
        return true;
      }
    }
    return false;
  }

  getOption(option: string): string {
    for (let i = 0; i < this.args.length; i++) {
      let arg = this.args[i];
      if (arg === option && i + 1 < this.args.length) {
        return this.args[i + 1];
      }
      let optPrefix = option + "=";
      if (arg.length > optPrefix.length) {
        let prefixMatch = true;
        for (let j = 0; j < optPrefix.length; j++) {
          if (arg.charCodeAt(j) !== optPrefix.charCodeAt(j)) {
            prefixMatch = false;
            break;
          }
        }
        if (prefixMatch) {
          return arg.slice(optPrefix.length, arg.length);
        }
      }
    }
    return "";
  }
}

export class Process {
  static argv: string[];
  static argc: number;

  static getenv(name: string): string {
    return getenv(name);
  }

  static exit(code: i32): never {
    exit(code);
  }
}

export class process {
  static argv: string[];
  static argc: number;

  static getenv(name: string): string {
    return getenv(name);
  }

  static exit(code: i32): never {
    exit(code);
  }
}

